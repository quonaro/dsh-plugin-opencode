// Smoke test: load the built bundle in a stub cordis context, assert the tool
// registers, and run it end-to-end against a fake `opencode` shell script.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { spawn as spawnChild } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const plugin = await import('../lib/index.js')
assert.equal(plugin.name, '@quonaro/dsh-plugin-opencode')
assert.equal(typeof plugin.apply, 'function')

// Fake opencode CLI: emits one ndjson text event + step_finish on stdout,
// echoes the argv to stderr for assertion, exits 0.
const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-opencode-'))
const fakeOpencode = join(dir, 'opencode')
writeFileSync(fakeOpencode, `#!/bin/sh
echo '{"type":"text","sessionID":"ses_fake","part":{"id":"p1","text":"FAKE-OPENCODE-OK"}}'
echo '{"type":"step_finish","part":{"tokens":{"input":10,"output":3},"cost":0}}'
echo "$@" >&2
`)
chmodSync(fakeOpencode, 0o755)

const registered = []
const ctx = {
  tools: { register: (def) => registered.push(def) },
  inject: (_services, fn) => {},
  subprocess: {
    async resolveExecutable(cmd) { return cmd },
    spawn(spec) {
      const spawn = spawnChild
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env } })
      const buffers = { stdout: [], stderr: [] }
      child.stdout.on('data', (d) => buffers.stdout.push(d))
      child.stderr.on('data', (d) => buffers.stderr.push(d))
      const collected = {}
      for (const stream of ['stdout', 'stderr']) {
        collected[stream] = {
          readFrom: () => ({ text: Buffer.concat(buffers[stream]).toString(), nextOffset: 0, lossy: false }),
        }
      }
      return {
        pid: child.pid,
        collected,
        done: new Promise((res) => child.on('close', (exitCode, signal) => res({ exitCode, signal }))),
        terminate() { child.kill('SIGTERM') },
        async waitForExit() { return true },
      }
    },
  },
}
// ctx.inject signature check: our stub above is sync no-op; commands service absent — fine.
const config = Object.fromEntries(
  Object.entries({
    opencodePath: fakeOpencode, auto: true, model: '', agent: '', attach: '', pure: false,
    timeoutMs: 60000, maxOutputBytes: 1048576,
    forwardEnv: [], extraArgs: [],
  }).map(([k, v]) => [k, { get: () => v }]),
)

plugin.apply(ctx, config)
assert.equal(registered.length, 1)
const tool = registered[0]
assert.equal(tool.name, 'opencode')

const result = await tool.execute(
  { prompt: 'hello from smoke' },
  { callId: 'smoke', name: 'opencode', arguments: { prompt: 'hello from smoke' }, signal: new AbortController().signal },
)
assert.equal(result.ok, true)
assert.equal(result.sessionId, 'ses_fake')
assert.equal(result.outputTokens, 3)
assert.match(result.stdout, /FAKE-OPENCODE-OK/)
assert.match(result.stderr, /--auto/)
assert.match(result.stderr, /--format json/)
assert.match(result.stderr, /hello from smoke/)
console.log('smoke: PASS')
