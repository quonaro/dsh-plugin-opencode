/**
 * Shared internals for dsh-plugin-opencode entry points: the ctx.subprocess
 * structural face, env forwarding, `opencode run` argv assembly, and the
 * incremental `--format json` event parser shared by the tool and provider.
 * @module dsh-plugin-opencode/shared
 */

/** Minimal structural face of @deepseek-ai/dsh-subprocess (ctx.subprocess). */
export interface SubprocessLike {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore' | 'pipe' | { readonly data: string }
      stdout: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
      stderr: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
    }
    graceMs: number
    signal?: AbortSignal | undefined
    env?: NodeJS.ProcessEnv | undefined
  }): {
    readonly pid: number
    readonly stdin: NodeJS.WritableStream | undefined
    readonly stdout: NodeJS.ReadableStream | undefined
    readonly stderr: NodeJS.ReadableStream | undefined
    readonly collected: {
      readonly stdout?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
      readonly stderr?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
    }
    readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
    terminate(): void
    waitForExit(signal?: AbortSignal): Promise<boolean>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessLike
  }
}

/** Collect the env entries a forwardEnv list names, skipping unset variables. */
export function forwardedEnv(names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of names) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export interface OpencodeCliFlags {
  /** `-m provider/model`; empty means the opencode config/agent default. */
  model?: string | undefined
  /** `--agent` sub-agent to run. */
  agent?: string | undefined
  /** `--auto` auto-approve permissions that are not explicitly denied (dangerous). */
  auto?: boolean | undefined
  /** `--session ses_…` continues an existing session. */
  session?: string | undefined
  /** `-c` continues the most recent session. */
  continueLast?: boolean | undefined
  /** `--fork` forks the continued session instead of resuming in place. */
  fork?: boolean | undefined
  /** `--attach <url>` drives a running `opencode serve` instance. */
  attach?: string | undefined
  /** `--pure` disables external opencode plugins. */
  pure?: boolean | undefined
  /** `--format`; 'json' emits raw ndjson events, 'default' formatted text. */
  format?: 'default' | 'json' | undefined
  /** Extra flags appended verbatim before the prompt. */
  extraArgs?: readonly string[] | undefined
}

/**
 * Assemble `opencode run` argv (without the executable itself).
 * The prompt is always last, behind `--`, so it can never parse as a flag.
 */
export function opencodeRunArgv(flags: OpencodeCliFlags, prompt: string): string[] {
  const argv: string[] = ['run']
  if (flags.model) argv.push('-m', flags.model)
  if (flags.agent) argv.push('--agent', flags.agent)
  if (flags.auto) argv.push('--auto')
  if (flags.fork) argv.push('--fork')
  if (flags.session) argv.push('--session', flags.session)
  else if (flags.continueLast) argv.push('-c')
  if (flags.attach) argv.push('--attach', flags.attach)
  if (flags.pure) argv.push('--pure')
  if (flags.format && flags.format !== 'default') argv.push('--format', flags.format)
  if (flags.extraArgs) argv.push(...flags.extraArgs)
  argv.push('--', prompt)
  return argv
}

/* ---- `opencode run --format json` event stream ---------------------------
 *
 * The run emits newline-delimited JSON events; the ones this plugin reads:
 *   {"type":"text",        "sessionID":"ses_…", "part":{"id":"prt_…","text":"…"}}
 *   {"type":"step_finish", "part":{"tokens":{"input":n,"output":n,…},"cost":n}}
 *   {"type":"error",       "error":{"message":"…"}}   (shape best-effort)
 * Each `text` event carries the part's full current text keyed by part id, so
 * the parser keeps the latest text per part and reports only the grown suffix.
 */

export interface OpencodeRunSummary {
  /** Concatenated text of all text parts, in first-seen order. */
  text: string
  /** Session id observed on any event ('ses_…'), '' when none arrived. */
  sessionId: string
  /** Token totals summed across step_finish events. */
  inputTokens: number
  outputTokens: number
  /** Monetary cost summed across step_finish events. */
  cost: number
  /** Messages collected from `error`-type events. */
  errors: string[]
  /** Whether at least one recognized event was parsed. */
  sawEvents: boolean
}

interface JsonRunEvent {
  type?: string
  sessionID?: string
  part?: { id?: string; text?: string; tokens?: { input?: number; output?: number }; cost?: number }
  tokens?: { input?: number; output?: number }
  cost?: number
  error?: { message?: string; data?: { message?: string } } | string
  message?: string
}

/** Incremental ndjson parser: feed complete lines, read the running summary. */
export class JsonRunParser {
  private readonly parts = new Map<string, string>()
  private readonly emitted = new Map<string, number>()
  sessionId = ''
  inputTokens = 0
  outputTokens = 0
  cost = 0
  readonly errors: string[] = []
  sawEvents = false

  /** Feed one complete stdout line; returns the text delta it produced. */
  feedLine(line: string): string {
    if (!line.trim()) return ''
    let event: JsonRunEvent
    try {
      event = JSON.parse(line) as JsonRunEvent
    } catch {
      return ''
    }
    this.sawEvents = true
    if (typeof event.sessionID === 'string' && event.sessionID) this.sessionId = event.sessionID

    if (event.type === 'text' && event.part && typeof event.part.text === 'string') {
      const id = event.part.id ?? `anon-${this.parts.size}`
      const next = event.part.text
      const prev = this.parts.get(id) ?? ''
      this.parts.set(id, next)
      // Emit only the grown suffix; a rewritten part re-emits whole.
      if (next.startsWith(prev)) {
        const delta = next.slice(this.emitted.get(id) ?? prev.length)
        this.emitted.set(id, next.length)
        return delta
      }
      const delta = (this.emitted.has(id) ? '\n' : '') + next
      this.emitted.set(id, next.length)
      return delta
    }

    if (event.type === 'step_finish') {
      const tokens = event.part?.tokens ?? event.tokens
      if (tokens) {
        this.inputTokens += tokens.input ?? 0
        this.outputTokens += tokens.output ?? 0
      }
      this.cost += event.part?.cost ?? event.cost ?? 0
      return ''
    }

    if (event.type === 'error') {
      const message = typeof event.error === 'string'
        ? event.error
        : event.error?.message ?? event.error?.data?.message ?? event.message ?? 'unknown opencode error'
      this.errors.push(message)
    }
    return ''
  }

  /** Feed a chunk of stdout; returns the text delta it produced. */
  feed(text: string, carry: { buffer: string }): string {
    carry.buffer += text
    let delta = ''
    let idx: number
    while ((idx = carry.buffer.indexOf('\n')) >= 0) {
      delta += this.feedLine(carry.buffer.slice(0, idx))
      carry.buffer = carry.buffer.slice(idx + 1)
    }
    return delta
  }

  /** Flush any buffered lines plus a trailing unterminated one. */
  finish(carry: { buffer: string }): OpencodeRunSummary {
    this.feed('', carry)
    if (carry.buffer.trim()) this.feedLine(carry.buffer)
    carry.buffer = ''
    return this.summary()
  }

  summary(): OpencodeRunSummary {
    return {
      text: [...this.parts.values()].join(''),
      sessionId: this.sessionId,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cost: this.cost,
      errors: [...this.errors],
      sawEvents: this.sawEvents,
    }
  }
}
