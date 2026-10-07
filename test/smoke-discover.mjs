// Smoke test for `opencode models` discovery: a fake `opencode` binary prints
// the catalog listing, one provider/model id per line.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as spawnChild } from 'node:child_process'
import assert from 'node:assert/strict'

const plugin = await import('../lib/provider.js')
assert.equal(plugin.name, '@quonaro/dsh-plugin-opencode/provider')

const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-opencode-disc-'))
const fakeOpencode = join(dir, 'opencode')
writeFileSync(fakeOpencode, `#!/bin/sh
echo 'opencode/big-pickle'
echo 'opencode/claude-sonnet-4-5'
echo 'openrouter/some-model'
echo 'not a model line'
`)
chmodSync(fakeOpencode, 0o755)

let registered = null
const ctx = {
  llm: {
    registerAdapter: (providers, adapter) => { registered = { providers, adapter }; return () => {} },
    registerConfigurableProviders: () => () => {},
  },
  subprocess: {
    async resolveExecutable(cmd) { return cmd },
    spawn(spec) {
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env } })
      const outBuf = []
      child.stdout.on('data', (d) => outBuf.push(d))
      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(outBuf).toString(), nextOffset: 0, lossy: false }) },
        },
        done: new Promise((res) => child.on('close', (exitCode, signal) => res({ exitCode, signal }))),
        terminate() { child.kill('SIGTERM') },
        async waitForExit() { return true },
      }
    },
  },
}
const config = Object.fromEntries(
  Object.entries({
    opencodePath: fakeOpencode, auto: true, attach: '', pure: false, cwd: '',
    timeoutMs: 60000, stderrMaxBytes: 65536,
    forwardEnv: [], extraArgs: [],
    models: [{ id: 'default', opencodeModel: '', name: 'OpenCode (config default)' }],
    brief: 'B', localSessionTitles: true,
    autoDiscoverModels: true, discoveryTimeoutMs: 15000, discoveryCacheMs: 300000,
  }).map(([k, v]) => [k, { get: () => v }]),
)

plugin.apply(ctx, config)
const models = await registered.adapter.listModels('opencode')
const ids = models.map((m) => m.id)
assert.deepEqual(ids, ['default', 'opencode/big-pickle', 'opencode/claude-sonnet-4-5', 'openrouter/some-model'])
assert.equal(models[2].name, 'opencode/claude-sonnet-4-5')
assert.match(models[0].description, /headless/)
console.log('smoke-discover: PASS')
