/**
 * Model discovery for dsh-plugin-opencode/provider.
 *
 * Runs `opencode models` — the CLI's own catalog listing — and parses the
 * `provider/model` ids it prints, one per line. This is the same catalog the
 * agent's ACP configOptions advertise, but without paying for a session/new
 * handshake, which can take tens of seconds on a cold start (a full session
 * loads skills, commands, and the remote catalog). Failures return null so
 * callers can fall back to the static config table.
 *
 * @module dsh-plugin-opencode/discover
 */

import type { Context } from '@deepseek-ai/cordis'
import { forwardedEnv } from './shared.ts'

/** One advertised model discovered from `opencode models`. */
export interface DiscoveredModel {
  id: string
  name: string
  description?: string | undefined
}

/** Result of one successful discovery probe. */
export interface DiscoveryResult {
  models: DiscoveredModel[]
  /** The model id the agent currently has selected; `opencode models` does not report one. */
  currentId?: string | undefined
}

/**
 * Parse `opencode models` output: one `provider/model` id per line; anything
 * else (banners, warnings leaking to stdout) is skipped.
 */
export function modelsFromCliOutput(text: string): DiscoveryResult | null {
  const models: DiscoveredModel[] = []
  for (const raw of text.split('\n')) {
    const id = raw.trim()
    if (!/^[^\s/]+\/\S+$/.test(id)) continue
    models.push({ id, name: id })
  }
  return models.length ? { models } : null
}

/**
 * Discover the model catalog by listing `opencode models`.
 * The child is expected to exit on its own; terminate it in `finally` anyway.
 */
export async function discoverModels(
  ctx: Context,
  opts: {
    opencodePath: string
    env: readonly string[]
    cwd: string
    timeoutMs: number
    stderrMaxBytes?: number | undefined
    stdoutMaxBytes?: number | undefined
    signal?: AbortSignal | undefined
  },
): Promise<DiscoveryResult | null> {
  const env = forwardedEnv(opts.env)
  const executable = await ctx.subprocess.resolveExecutable(opts.opencodePath, env, opts.signal)

  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

  const handle = ctx.subprocess.spawn({
    argv: [executable, 'models'],
    cwd: opts.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: opts.stdoutMaxBytes ?? 4_194_304 },
      stderr: { maxBytes: opts.stderrMaxBytes ?? 65_536 },
    },
    graceMs: 5_000,
    signal,
    env,
  })

  try {
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return null
    return modelsFromCliOutput(handle.collected.stdout?.readFrom(0).text ?? '')
  } finally {
    handle.terminate()
    await handle.waitForExit(AbortSignal.timeout(6_000)).catch(() => false)
  }
}
