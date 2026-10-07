/**
 * dsh-plugin-opencode — delegate tasks to the OpenCode CLI from DeepSeek Harness.
 *
 * Registers one model-facing tool, `opencode`, which spawns `opencode run`
 * (headless) through the ctx.subprocess seam: bounded captured output,
 * process-tree termination, and abort-signal escalation come from the seam.
 * A `/opencode <prompt>` slash command is added when the host composes the
 * commands service. Runs use `--format json`; the event stream is parsed into
 * the answer text, session id, and token usage.
 *
 * Auth: the spawned CLI reads credentials stored by `opencode auth login`
 * (~/.local/share/opencode), reached via HOME/XDG_* in Config.forwardEnv.
 *
 * @module @quonaro/dsh-plugin-opencode
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JsonRunParser, forwardedEnv, opencodeRunArgv } from './shared.ts'

/** Host plugin name; must match package.json `name` and the cordis.patch.yml row id. */
export const name = '@quonaro/dsh-plugin-opencode'

/** Services this plugin needs before it loads: the tool registry and a subprocess provider. */
export const inject = ['tools', 'subprocess']

/** Plugin configuration; every field is a Volatile re-read at each call. */
export interface Config {
  /** Path or PATH-resolved name of the opencode executable. */
  opencodePath: Volatile<string>
  /** `--auto`: auto-approve permissions not explicitly denied. Headless runs cannot answer prompts. */
  auto: Volatile<boolean>
  /** Default `-m provider/model`; empty string means the opencode config default. */
  model: Volatile<string>
  /** Default `--agent`; empty string means the default agent. */
  agent: Volatile<string>
  /** `--attach` a running `opencode serve` URL instead of a local instance. */
  attach: Volatile<string>
  /** `--pure`: run without external opencode plugins. */
  pure: Volatile<boolean>
  /** Cooperative timeout in milliseconds for one delegation call. */
  timeoutMs: Volatile<number>
  /** In-memory cap per captured stream; overflow keeps the tail. */
  maxOutputBytes: Volatile<number>
  /** Environment variable names forwarded to the opencode child process. */
  forwardEnv: Volatile<string[]>
  /** Extra CLI flags appended verbatim before the prompt. */
  extraArgs: Volatile<string[]>
}

/** Schemastery schema: defaults live here; cordis.yml and GUI edits are validated against it. */
export const Config = Schema.object({
  opencodePath: Schema.string().default('opencode').volatile(),
  auto: Schema.boolean().default(true).volatile(),
  model: Schema.string().default('').volatile(),
  agent: Schema.string().default('').volatile(),
  attach: Schema.string().default('').volatile(),
  pure: Schema.boolean().default(false).volatile(),
  timeoutMs: Schema.number().default(600_000).volatile(),
  maxOutputBytes: Schema.number().default(1_048_576).volatile(),
  forwardEnv: Schema.array(Schema.string()).default([
    'PATH', 'HOME', 'USER', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'OPENCODE_CONFIG', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD',
  ]).volatile(),
  extraArgs: Schema.array(Schema.string()).default([]).volatile(),
})

/** Canonical result of one opencode delegation, declared by output.schema. */
interface OpencodeRunResult {
  ok: boolean
  exitCode: number
  signal: string
  timedOut: boolean
  truncated: boolean
  /** `ses_…` id from the run's events — pass back as `session` to continue it. */
  sessionId: string
  inputTokens: number
  outputTokens: number
  stdout: string
  stderr: string
}

interface OpencodeRunOptions {
  prompt: string
  cwd: string
  model?: string | undefined
  agent?: string | undefined
  session?: string | undefined
  continueLast?: boolean | undefined
  auto?: boolean | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

/** Spawn `opencode run` once and collect bounded stdout/stderr. Shared by the tool and the command. */
async function runOpencode(ctx: Context, config: Config, options: OpencodeRunOptions): Promise<OpencodeRunResult> {
  const env = forwardedEnv(config.forwardEnv.get())
  const executable = await ctx.subprocess.resolveExecutable(config.opencodePath.get(), env, options.signal)

  const timeoutMs = options.timeoutMs ?? config.timeoutMs.get()
  const argv = [
    executable,
    ...opencodeRunArgv({
      model: options.model ?? config.model.get(),
      agent: options.agent ?? config.agent.get(),
      auto: options.auto ?? config.auto.get(),
      session: options.session,
      continueLast: options.continueLast,
      attach: config.attach.get(),
      pure: config.pure.get(),
      format: 'json',
      extraArgs: config.extraArgs.get(),
    }, options.prompt),
  ]

  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const maxBytes = config.maxOutputBytes.get()

  const handle = ctx.subprocess.spawn({
    argv,
    cwd: options.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes },
      stderr: { maxBytes },
    },
    graceMs: 10_000,
    signal,
    env,
  })

  const outcome = await handle.done
  const rawStdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  const timedOut = timeout.aborted

  const parser = new JsonRunParser()
  const summary = parser.finish({ buffer: rawStdout?.text ?? '' })
  // Fall back to the raw stream when the run emitted no events (e.g. a
  // --format override in extraArgs, or output from a failed early exit).
  const stdout = summary.sawEvents ? summary.text : (rawStdout?.text ?? '')
  const eventErrors = summary.errors.length ? `opencode errors: ${summary.errors.join('; ')}` : ''
  const stderrText = [stderr?.text ?? '', eventErrors].filter(Boolean).join('\n')

  return {
    ok: !timedOut && outcome.exitCode === 0 && summary.errors.length === 0,
    exitCode: outcome.exitCode ?? -1,
    signal: outcome.signal ?? '',
    timedOut,
    truncated: Boolean(rawStdout?.lossy || stderr?.lossy),
    sessionId: summary.sessionId,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    stdout,
    stderr: stderrText,
  }
}

function renderResult(result: OpencodeRunResult): string {
  const head = result.timedOut
    ? 'opencode timed out and was terminated.'
    : result.ok
      ? 'opencode finished successfully.'
      : `opencode exited with code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ''}.`
  const meta = result.sessionId ? `\n[session: ${result.sessionId} — pass as "session" to continue]` : ''
  const tail = result.truncated ? '\n[output truncated — tail shown]' : ''
  return `${head}${meta}\n\n${result.stdout || '(no output)'}${result.stderr ? `\n\n--- stderr ---\n${result.stderr}` : ''}${tail}`
}

/** /opencode command payload shape (minimal subset of dsh-commands CommandInvocation). */
interface OpencodeCommandInvocation {
  readonly rawInput: string
}

interface OpencodeCommandResult {
  kind: 'success' | 'error'
  text?: string
}

interface OpencodeCommandsLike {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly handler: (invocation: OpencodeCommandInvocation) => OpencodeCommandResult | Promise<OpencodeCommandResult>
  }): unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Command registry (provided at runtime by @deepseek-ai/dsh-commands, optional). */
    commands: OpencodeCommandsLike
  }
}

/**
 * Plugin body: register the `opencode` tool, and `/opencode` when a commands
 * service is composed. All registrations are effects — unloading the plugin
 * reverts them automatically.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'opencode',
    description:
      'Delegate a task to the OpenCode agent (`opencode run`, headless). OpenCode works ' +
      'autonomously in the given directory and its final answer is returned as text. ' +
      'Prefer this for self-contained chunks of work you want a second agent to own ' +
      'end-to-end. The call blocks until OpenCode finishes or the configured timeout fires.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The task for OpenCode, written self-contained — it does not see this conversation.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the OpenCode session. Defaults to the current directory.',
      },
      model: {
        type: 'string',
        description: 'Model override in provider/model form (e.g. "opencode/claude-sonnet-4-5"). Defaults to the plugin config value.',
      },
      agent: {
        type: 'string',
        description: 'OpenCode sub-agent to run (e.g. "build", "plan"). Defaults to the plugin config value.',
      },
      session: {
        type: 'string',
        description: 'Continue an existing OpenCode session by id (ses_…) instead of starting a new one.',
      },
      continueLast: {
        type: 'boolean',
        description: 'Continue the most recent OpenCode session in cwd. Ignored when session is set.',
      },
      auto: {
        type: 'boolean',
        description: 'Auto-approve permission requests (--auto). Headless runs cannot answer prompts; the default comes from plugin config.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds for this call. Defaults to the plugin config value.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          exitCode: { type: 'integer', required: true },
          signal: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
          sessionId: { type: 'string', required: true },
          inputTokens: { type: 'integer', required: true },
          outputTokens: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      return runOpencode(ctx, config, {
        prompt: args.prompt,
        cwd: args.cwd ?? process.cwd(),
        model: args.model,
        agent: args.agent,
        session: args.session,
        continueLast: args.continueLast,
        auto: args.auto,
        timeoutMs: args.timeoutMs,
        signal: exec.signal,
      })
    },
    presentResult: (_args, result) => ({
      card: 'generic' as const,
      title: 'opencode',
      content: result.content,
    }),
  }))

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'opencode',
      description: 'Delegate a task to the OpenCode agent (opencode run). Usage: /opencode <task>',
      handler: async ({ rawInput }) => {
        const prompt = rawInput.trim()
        if (!prompt) return { kind: 'error' as const, text: 'Usage: /opencode <task for OpenCode>' }
        const result = await runOpencode(ctx, config, { prompt, cwd: process.cwd() })
        return {
          kind: result.ok ? ('success' as const) : ('error' as const),
          text: renderResult(result),
        }
      },
    })
  })
}
