# dsh-plugin-opencode

Unofficial bridge between the [OpenCode](https://opencode.ai) CLI and DeepSeek Harness: an `opencode` delegation tool plus a `/opencode` command running `opencode run` (headless), and an `opencode-agent` LLM provider route with automatic model discovery via `opencode models` — all over the `ctx.subprocess` seam. Not affiliated with the OpenCode project.

## What the agent gets

- **`opencode` tool** — spawns `opencode run --format json "<prompt>"` as a managed child process. Per-call `cwd`, `model` (`provider/model`), `agent`, `session`, `continueLast`, `auto`, and `timeoutMs`. Returns `{ ok, exitCode, stdout, stderr, timedOut, truncated, sessionId, inputTokens, outputTokens }`. The ndjson event stream is parsed into the answer text; `sessionId` can be passed back as `session` to continue a run.
- **`/opencode <task>`** — slash command shortcut (when the profile composes the commands service).

Cancelling the tool call aborts the child via the subprocess seam's terminate escalation (SIGTERM → grace → SIGKILL on the process tree); output capture is bounded and keeps the tail on overflow.

## The provider route

`@quonaro/dsh-plugin-opencode/provider` registers `opencode-agent` with `ctx.llm.registerAdapter`, so OpenCode appears next to ordinary model providers (Settings → Models, `/model`, agent presets). Each generation spawns `opencode run --format json` with the flattened transcript and streams its text back; token usage is real, summed from `step_finish` events.

The route is `opencode-agent`, not `opencode`: the pi-ai catalog already owns `opencode` (OpenCode's own HTTP API), and the configurable-provider directory rejects duplicates.

The adapter lists `opencode models` for the agent's real model catalog and caches the result; disable via `autoDiscoverModels` to use the static `models` table.

OpenCode is an agent, not a model — each call is a full autonomous session. Use it to hand whole tasks to OpenCode; latency is seconds to minutes.

## Prerequisites

- `opencode` CLI on `PATH` (or set `opencodePath` to an absolute path)
- `opencode auth login` completed (credentials live in `~/.local/share/opencode`, reached via `HOME`/`XDG_*` in `forwardEnv`)

## Install

```sh
# from a local checkout
dsh plugin --profile <your-profile> add /path/to/dsh-plugin-opencode
```

The package declares `dsh.bundle`, so `dsh plugin add` applies `cordis.patch.yml` to the profile automatically. On pnpm ≥ 10 the first git install refuses the `prepare` build — copy the package key pnpm prints into the profile's `pnpm-workspace.yaml` `allowBuilds:` and re-run.

## Configuration

Edit the `dsh-plugin-opencode` row in the profile's `cordis.patch.yml`, or the derived settings namespace in the GUI. All fields are volatile — changes apply to the next call without a restart.

| Key              | Default                           | Notes                                                                                                                                                                  |
| ---------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencodePath`   | `opencode`                        | Executable name or absolute path                                                                                                                                       |
| `auto`           | `true`                            | `--auto` auto-approves permissions not explicitly denied — headless runs can't answer prompts; marked dangerous upstream, tighten via `permission` in `opencode.jsonc` |
| `model`          | `''`                              | `-m provider/model`; empty = opencode config default                                                                                                                   |
| `agent`          | `''`                              | `--agent` sub-agent (e.g. `build`, `plan`)                                                                                                                             |
| `attach`         | `''`                              | `--attach <url>` drives a running `opencode serve` instead of a local instance                                                                                         |
| `pure`           | `false`                           | `--pure` disables external opencode plugins                                                                                                                            |
| `timeoutMs`      | `600000`                          | Cooperative timeout per delegation call                                                                                                                                |
| `maxOutputBytes` | `1048576`                         | In-memory cap per captured stream; overflow keeps the tail                                                                                                             |
| `forwardEnv`     | PATH/HOME/USER/XDG*\*/OPENCODE*\* | Env vars forwarded to the child                                                                                                                                        |
| `extraArgs`      | `[]`                              | Extra CLI flags appended before the prompt                                                                                                                             |

Provider row (`dsh-plugin-opencode-provider`) adds `cwd`, `stderrMaxBytes`, `models` (static route→`-m` table), `brief`, `localSessionTitles`, `autoDiscoverModels`, `discoveryTimeoutMs`, `discoveryCacheMs`.

## Notes

- `--session`/`continueLast`/`fork`/`agent` are per-call tool parameters; `session`/`continueLast`/`fork` live on the tool, not the provider route (a model route has no session handle).
- The tool result's `sessionId` (`ses_…`) enables multi-turn delegation across calls.
