/**
 * @quonaro/dsh-plugin-opencode/provider — expose the OpenCode CLI as an LLM
 * provider route.
 *
 * Registers provider `opencode-agent` with `ctx.llm.registerAdapter`, so it appears
 * alongside ordinary model providers (Settings → Models, `/model`, agent
 * presets). Each generation spawns `opencode run --format json` with the
 * flattened transcript and streams its text events back as one text block.
 * Token usage is real — summed from the run's step_finish events.
 *
 * Semantics worth knowing before enabling: OpenCode is an agent, not a model.
 * Every call is a complete headless OpenCode session — it runs its own tool
 * loop internally and cannot invoke this harness's tools. Use it to hand
 * whole tasks to OpenCode; per-token latency is seconds to minutes, not
 * milliseconds.
 *
 * @module @quonaro/dsh-plugin-opencode/provider
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { JsonRunParser, forwardedEnv, opencodeRunArgv } from './shared.ts'
import { discoverModels, type DiscoveryResult } from './discover.ts'

// Re-exported so the inferred Config type can name Dict in the emitted .d.ts (TS2883).
export type { Dict } from '@deepseek-ai/cosmokit'

/** Plugin name; the cordis.patch.yml row uses the `@quonaro/dsh-plugin-opencode/provider` specifier. */
export const name = '@quonaro/dsh-plugin-opencode/provider'

/** Services this plugin needs: the llm adapter registry and a subprocess provider. */
export const inject = ['llm', 'subprocess']

/** Plugin configuration; every field is a Volatile re-read at each call. */
export interface Config {
  /** Path or PATH-resolved name of the opencode executable. */
  opencodePath: Volatile<string>
  /** `--auto`: auto-approve permissions not explicitly denied. Headless runs cannot answer prompts. */
  auto: Volatile<boolean>
  /** `--attach` a running `opencode serve` URL instead of a local instance. */
  attach: Volatile<string>
  /** `--pure`: run without external opencode plugins. */
  pure: Volatile<boolean>
  /** Working directory for every spawned session; empty = the harness cwd. */
  cwd: Volatile<string>
  /** Cooperative timeout in milliseconds per generation. OpenCode runs are slow. */
  timeoutMs: Volatile<number>
  /** In-memory cap for the captured stderr tail surfaced on failure. */
  stderrMaxBytes: Volatile<number>
  /** Environment variable names forwarded to the opencode child process. */
  forwardEnv: Volatile<string[]>
  /** Extra CLI flags appended verbatim before the prompt. */
  extraArgs: Volatile<string[]>
  /**
   * Advertised models, in selector order. `id` is the route model id passed via
   * GenerateOptions.model; `opencodeModel` is the `-m` value in provider/model
   * form ('' = the agent's configured default); `name` is the display name in
   * the model selector.
   */
  models: Volatile<{ id: string; opencodeModel: string; name: string }[]>
  /**
   * Instruction prepended to every flattened transcript, telling OpenCode it
   * runs as a model backend and must finish autonomously.
   */
  brief: Volatile<string>
  /** Answer session-title requests locally instead of spending an OpenCode run on them. */
  localSessionTitles: Volatile<boolean>
  /** List `opencode models` for the agent's real model catalog instead of using the static `models` table. */
  autoDiscoverModels: Volatile<boolean>
  /** Timeout for one `opencode models` listing. */
  discoveryTimeoutMs: Volatile<number>
  /** How long a successful discovery result is cached before re-probing. */
  discoveryCacheMs: Volatile<number>
}

const DEFAULT_BRIEF =
  'You are OpenCode, an autonomous software-engineering agent, invoked as the model backend ' +
  'of another agent harness. The transcript of the calling conversation is below. Carry out ' +
  'the most recent user request end-to-end using your own tools and judgment. Do not ask ' +
  'questions — act autonomously. Your final printed answer is returned verbatim as the ' +
  "model's reply."

/** Schemastery schema: defaults live here; cordis.yml and GUI edits are validated against it. */
export const Config = Schema.object({
  opencodePath: Schema.string().default('opencode').volatile(),
  auto: Schema.boolean().default(true).volatile(),
  attach: Schema.string().default('').volatile(),
  pure: Schema.boolean().default(false).volatile(),
  cwd: Schema.string().default('').volatile(),
  timeoutMs: Schema.number().default(1_800_000).volatile(),
  stderrMaxBytes: Schema.number().default(65_536).volatile(),
  forwardEnv: Schema.array(Schema.string()).default([
    'PATH', 'HOME', 'USER', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'OPENCODE_CONFIG', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD',
  ]).volatile(),
  extraArgs: Schema.array(Schema.string()).default([]).volatile(),
  models: Schema.array(Schema.object({
    id: Schema.string(),
    opencodeModel: Schema.string().default(''),
    name: Schema.string().default(''),
  })).default([
    { id: 'default', opencodeModel: '', name: 'OpenCode (config default)' },
  ] as { id: string; opencodeModel: string; name: string }[]).volatile(),
  brief: Schema.string().default(DEFAULT_BRIEF).volatile(),
  localSessionTitles: Schema.boolean().default(true).volatile(),
  autoDiscoverModels: Schema.boolean().default(true).volatile(),
  discoveryTimeoutMs: Schema.number().default(60_000).volatile(),
  discoveryCacheMs: Schema.number().default(300_000).volatile(),
})

const ROLE_LABEL: Record<string, string> = {
  system: 'system',
  developer: 'developer',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool result',
}

/** Project one message's blocks into transcript text. */
function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text': return block.text
      case 'reasoning': return `<thinking>\n${block.text}\n</thinking>`
      case 'tool-call': return `[tool call ${block.name} #${block.id}]: ${block.arguments}`
      case 'image': return '[image]'
      case 'file': return '[file]'
      case 'tool-addition': return `[tool enabled: ${block.toolName}]`
      case 'tool-removal': return `[tool disabled: ${block.toolName}]`
      default: return `[${(block as { type: string }).type}]`
    }
  }).join('\n')
}

/** Flatten one generation request into the prompt handed to `opencode run`. */
function buildPrompt(options: GenerateOptions, brief: string): string {
  const parts: string[] = [brief, '', '<transcript>']
  if (options.system) parts.push('## system', options.system, '')
  for (const message of options.messages) {
    parts.push(`## ${ROLE_LABEL[message.role] ?? message.role}`, blocksToText(message.content), '')
  }
  parts.push('</transcript>')
  if (options.tools?.length) {
    const names = options.tools.map((tool: ToolSchema) => tool.name).slice(0, 12).join(', ')
    parts.push('', `[note: the caller declared ${options.tools.length} of its own tools (${names}${options.tools.length > 12 ? ', …' : ''}) — you cannot invoke them; complete the work with your own capabilities.]`)
  }
  return parts.join('\n')
}

/** Map an advertised route id to its `-m` value; unknown ids pass through verbatim. */
function resolveOpencodeModel(routeId: string, table: readonly { id: string; opencodeModel: string }[]): string {
  const entry = table.find((m) => m.id === routeId)
  if (entry) return entry.opencodeModel
  return routeId === 'default' ? '' : routeId
}

/**
 * Prefix the host wraps session-title requests in (`dsh-session-title-llm`
 * `frameMessages`): the actual human messages sit inside a JSON payload.
 */
const TITLE_FRAME_PREFIX = 'Generate the session title from this JSON array of human messages:'

/**
 * Source text for a cheap local session title: the last user message, with the
 * host's title-request JSON framing unwrapped to the first framed human message.
 */
function sessionTitleText(messages: readonly RequestMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const raw = blocksToText(message.content)
    const at = raw.indexOf(TITLE_FRAME_PREFIX)
    if (at === -1) return raw.replace(/\s+/g, ' ').trim() || 'OpenCode session'
    try {
      const items = JSON.parse(raw.slice(at + TITLE_FRAME_PREFIX.length)) as unknown
      if (Array.isArray(items)) {
        // Host items are `{seq, text}` projections of the eligible human
        // messages; keep `content` blocks as a fallback shape.
        for (const item of items as readonly { text?: unknown; content?: ContentBlock[] }[]) {
          if (!item) continue
          const rawText = typeof item.text === 'string'
            ? item.text
            : Array.isArray(item.content) ? blocksToText(item.content) : ''
          const text = rawText.replace(/\s+/g, ' ').trim()
          if (text) return text
        }
      }
    } catch {
      // Framed payload did not parse — fall back below.
    }
    return 'OpenCode session'
  }
  return 'OpenCode session'
}

/**
 * The provider-wire adapter. Duck-typed against the documented LlmAdapter
 * surface — the registry validates behavior, not inheritance — so this class
 * carries no runtime import of @deepseek-ai/dsh-llm.
 */
class OpencodeLlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'OpenCode ACP' }
  }

  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  private discovered: { at: number; result: DiscoveryResult } | undefined

  /** List `opencode models` for the real catalog (cached); null on failure/disabled. */
  private async discover(): Promise<DiscoveryResult | null> {
    if (!this.config.autoDiscoverModels.get()) return null
    const cacheMs = this.config.discoveryCacheMs.get()
    if (this.discovered && Date.now() - this.discovered.at < cacheMs) return this.discovered.result
    try {
      const result = await discoverModels(this.ctx, {
        opencodePath: this.config.opencodePath.get(),
        env: this.config.forwardEnv.get(),
        cwd: this.config.cwd.get() || process.cwd(),
        timeoutMs: this.config.discoveryTimeoutMs.get(),
        stderrMaxBytes: this.config.stderrMaxBytes.get(),
      })
      if (result) this.discovered = { at: Date.now(), result }
      return result
    } catch {
      return null
    }
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const discovered = await this.discover()
    if (discovered && discovered.models.length > 0) {
      const currentId = discovered.currentId
      return [
        {
          provider,
          id: 'default',
          name: 'OpenCode (config default)',
          description: currentId ? `Resolves to the configured default (${currentId})` : 'OpenCode agent, spawned headless per generation',
          inputModalities: ['text' as const],
        },
        ...discovered.models.map((m) => ({
          provider,
          id: m.id,
          name: m.name,
          description: m.description ?? 'OpenCode agent, spawned headless per generation',
          inputModalities: ['text' as const] as readonly ('text')[],
        })),
      ]
    }
    return this.config.models.get().map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name || `OpenCode ${entry.id}`,
      description: 'OpenCode agent, spawned headless per generation',
      inputModalities: ['text' as const],
    }))
  }

  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: `OpenCode ${model}`,
      inputModalities: ['text' as const],
    })
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Cheap path: session-title generations are short text requests — spending a
    // whole OpenCode agent run on them would burn tokens for a one-line answer.
    if (options.purpose === 'session-title' && this.config.localSessionTitles.get()) {
      const text = sessionTitleText(options.messages).slice(0, 80)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const env = forwardedEnv(this.config.forwardEnv.get())
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.opencodePath.get(), env, options.signal)

    const timeout = AbortSignal.timeout(this.config.timeoutMs.get())
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

    const prompt = buildPrompt(options, this.config.brief.get())
    const argv = [
      executable,
      ...opencodeRunArgv({
        model: resolveOpencodeModel(options.model, this.config.models.get()),
        auto: this.config.auto.get(),
        attach: this.config.attach.get(),
        pure: this.config.pure.get(),
        format: 'json',
        extraArgs: this.config.extraArgs.get(),
      }, prompt),
    ]

    const handle = this.ctx.subprocess.spawn({
      argv,
      cwd: this.config.cwd.get() || process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: { maxBytes: this.config.stderrMaxBytes.get() },
      },
      graceMs: 10_000,
      signal,
      env,
    })

    const parser = new JsonRunParser()
    const carry = { buffer: '' }
    const decoder = new TextDecoder()

    yield { type: 'block-start', index: 0, blockType: 'text' }
    const stdout = handle.stdout as AsyncIterable<Uint8Array> | undefined
    if (stdout) {
      for await (const chunk of stdout) {
        const delta = parser.feed(decoder.decode(chunk, { stream: true }), carry)
        if (delta) yield { type: 'text-delta', index: 0, text: delta }
      }
    }

    const outcome = await handle.done
    const summary = parser.finish(carry)
    // Fallback for runs that produced no events at all (early crash output).
    const text = summary.sawEvents ? summary.text : carry.buffer
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: {
        inputTokens: summary.inputTokens || Math.ceil(prompt.length / 4),
        outputTokens: summary.outputTokens || Math.ceil(text.length / 4),
      },
    }

    if (timeout.aborted) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'OPENCODE_TIMEOUT', message: `opencode exceeded timeoutMs=${this.config.timeoutMs.get()} and was terminated` },
        },
      }
    } else if (outcome.exitCode !== 0 || summary.errors.length > 0) {
      const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
      const detail = summary.errors.length ? summary.errors.join('; ') : stderr.slice(-400)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'OPENCODE_EXIT',
            message: `opencode exited ${outcome.exitCode ?? `signal ${outcome.signal}`}${detail ? ` — ${detail}` : ''}`,
          },
        },
      }
    } else {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/**
 * Plugin body: register the `opencode-agent` provider route and declare it in the
 * configurable-provider directory so the web Models page can see it.
 */
export function apply(ctx: Context, config: Config): void {
  // The route is `opencode-agent`, not `opencode`: the pi-ai catalog already
  // owns `opencode` (OpenCode's own API) and the directory rejects duplicates.
  ctx.llm.registerAdapter(['opencode-agent'], new OpencodeLlmAdapter(ctx, config))
  ctx.llm.registerConfigurableProviders([{
    provider: 'opencode-agent',
    displayName: 'OpenCode ACP',
    settingsNs: name,
    settingsPath: [],
  }])
}
