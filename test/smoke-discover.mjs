// Smoke test for ACP model discovery: a fake `opencode` binary speaks ndjson
// JSON-RPC — answers initialize, and session/new with a configOptions model list.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as spawnChild } from 'node:child_process'
import assert from 'node:assert/strict'

const plugin = await import('../lib/provider.js')
assert.equal(plugin.name, '@quonaro/dsh-plugin-opencode/provider')

const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-opencode-disc-'))
const fakeOpencode = join(dir, 'opencode')
writeFileSync(fakeOpencode, `#!/usr/bin/env node
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n')
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      sessionId: 'ses_fake',
      configOptions: [
        { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
        { id: 'model', category: 'model', type: 'select', currentValue: 'opencode/big-pickle', options: [
          { value: 'opencode/big-pickle', name: 'Big Pickle' },
          { value: 'opencode/claude-sonnet-4-5', name: 'Claude Sonnet' },
          { options: [{ value: 'openrouter/some-model', name: 'Grouped One' }], name: 'OpenRouter' }
        ] }
      ]
    } }) + '\\n')
  }
})
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
      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: {},
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
assert.equal(models[2].name, 'Claude Sonnet')
assert.match(models[0].description, /big-pickle/)
console.log('smoke-discover: PASS')
