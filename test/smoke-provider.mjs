// Smoke test for the provider half: load lib/provider.js in a stub context,
// capture the registered adapter, and run one generation end-to-end against a
// fake `opencode` binary that streams ndjson events.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as spawnChild } from 'node:child_process'
import assert from 'node:assert/strict'

const plugin = await import('../lib/provider.js')
assert.equal(plugin.name, '@quonaro/dsh-plugin-opencode/provider')
assert.equal(typeof plugin.apply, 'function')

// Fake opencode: streams two ndjson text events + step_finish then exits 0.
const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-opencode-prov-'))
const fakeOpencode = join(dir, 'opencode-agent')
writeFileSync(fakeOpencode, `#!/bin/sh
echo '{"type":"text","sessionID":"ses_fake","part":{"id":"p1","text":"chunk-one"}}'
sleep 0.05
echo '{"type":"text","sessionID":"ses_fake","part":{"id":"p2","text":"chunk-two"}}'
echo '{"type":"step_finish","part":{"tokens":{"input":42,"output":7},"cost":0.001}}'
`)
chmodSync(fakeOpencode, 0o755)

let registered = null
const configurable = []
const ctx = {
  llm: {
    registerAdapter: (providers, adapter) => { registered = { providers, adapter }; return () => {} },
    registerConfigurableProviders: (entries) => { configurable.push(...entries); return () => {} },
  },
  subprocess: {
    async resolveExecutable(cmd) { return cmd },
    spawn(spec) {
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env } })
      const errBuf = []
      child.stderr.on('data', (d) => errBuf.push(d))
      return {
        pid: child.pid,
        stdin: undefined,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: {
          stderr: { readFrom: () => ({ text: Buffer.concat(errBuf).toString(), nextOffset: 0, lossy: false }) },
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
    brief: 'TEST-BRIEF',
    localSessionTitles: true,
    autoDiscoverModels: false, discoveryTimeoutMs: 15000, discoveryCacheMs: 300000,
  }).map(([k, v]) => [k, { get: () => v }]),
)

plugin.apply(ctx, config)
assert.deepEqual(registered.providers, ['opencode-agent'])
assert.equal(registered.adapter.providerInfo('opencode-agent').name, 'OpenCode Agent')
assert.equal(configurable[0].provider, 'opencode-agent')

const models = await registered.adapter.listModels('opencode-agent')
assert.equal(models[0].id, 'default')
assert.equal(models[0].provider, 'opencode-agent')

// One generation: system + user message in, streamed text out.
const chunks = []
const prepared = await registered.adapter.prepareCall('opencode-agent', 'default')
for await (const chunk of prepared.stream({
  provider: 'opencode-agent',
  model: 'default',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
  ],
})) {
  chunks.push(chunk)
}

const types = chunks.map((c) => c.type)
assert.deepEqual(types[0], 'block-start')
assert.equal(types.at(-1), 'finish')
assert.equal(chunks.at(-1).reason.kind, 'stop')
const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
assert.match(text, /chunk-one/)
assert.match(text, /chunk-two/)
const usage = chunks.find((c) => c.type === 'usage')
assert.equal(usage.usage.outputTokens, 7)
assert.equal(usage.usage.inputTokens, 42)
console.log('smoke-provider: PASS')
