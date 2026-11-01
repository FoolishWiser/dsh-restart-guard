// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  AI_PRESETS,
  aiSettings,
  applyAiVerdict,
  buildAiRequest,
  callAi,
  callBridge,
  extractJson,
  parseVerdict,
  buildRepairPrompt,
  repairWithAi,
} from '../lib/shared/ai.js'
import { normalizeConfig } from '../lib/shared/config.js'
import { planRepairSteps } from '../lib/shared/plan.js'
import { createRequire } from 'node:module'

const config = normalizeConfig({}).config

/** @param {string} incident */
function planFor(incident) {
  return planRepairSteps({
    diagnosis: { incident, detail: 'boom', evidence: [], unresolved: [], inactive: [] },
    attempt: 1,
    config,
    maintenance: { active: false, signal: 'none', signals: [], until: 0, terminal: 'unknown', treeIntact: true, treeVersion: '', upgradeDir: '', restarters: [] },
    supervisor: { kind: 'none', mayAct: true, detail: '' },
    occupant: { pids: [], isDsh: false, cmdline: '' },
    port: 3079,
  })
}

test('ai settings: defaults are off, key comes from the named env var', () => {
  const off = aiSettings(config, {})
  assert.equal(off.enabled, false)
  assert.equal(off.endpoint, AI_PRESETS.deepseek.endpoint)
  // Default source is auto, so a harness credential store on this machine may
  // legitimately provide a key; only an env-only config must come up empty.
  assert.equal(aiSettings({ ai: { credentialSource: 'env' } }, {}).apiKey, '')

  const on = aiSettings({ ai: { enabled: true, preset: 'openai' } }, { OPENAI_API_KEY: 'sk-test' })
  assert.equal(on.enabled, true)
  assert.equal(on.model, 'gpt-4o-mini')
  assert.equal(on.apiKey, 'sk-test')

  const explicit = aiSettings({ ai: { enabled: true, keyEnv: 'MY_KEY' } }, { MY_KEY: 'k1', DEEPSEEK_API_KEY: 'k2' })
  assert.equal(explicit.apiKey, 'k1')
})

test('the prompt carries facts and a redacted log tail, and demands one JSON verdict', () => {
  const request = buildAiRequest({
    locale: 'zh',
    facts: { incident: 'yaml-config', detail: 'YAMLException', attempt: 1, maxAttempts: 2, port: 3079, maxLogBytes: 4000 },
    logText: 'dsh web: http://127.0.0.1:3079/?token=abcdefghijklmnopqrstuvwxyz\nauthorization: Bearer abc.def\nYAMLException: bad indentation',
  })
  assert.equal(request.messages.length, 2)
  const system = request.messages[0].content
  const user = request.messages[1].content
  assert.match(system, /"action":"retry\|rollback-patch\|wait\|manual"/)
  assert.match(system, /Simplified Chinese/)
  assert.match(user, /yaml-config/)
  assert.match(user, /YAMLException/)
  assert.ok(!user.includes('abcdefghijklmnopqrstuvwxyz'), 'launch token must be redacted')
  assert.ok(!user.includes('abc.def'), 'bearer token must be redacted')
})

test('parseVerdict tolerates fences and rejects anything outside the allow-list', () => {
  const fenced = parseVerdict('```json\n{"action":"retry","reason":"r","hint":"h","confidence":0.8}\n```')
  assert.equal(fenced.ok, true)
  if (fenced.ok) assert.equal(fenced.verdict.action, 'retry')

  const prose = parseVerdict('Sure! {"action":"rollback-patch","reason":"bad yaml","hint":"backup","confidence":2}')
  assert.equal(prose.ok, true)
  if (prose.ok) assert.equal(prose.verdict.confidence, 1)

  assert.equal(parseVerdict('{"action":"run-command"}').ok, false)
  assert.equal(parseVerdict('not json').ok, false)
  assert.equal(extractJson(''), null)
})

function stubServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('callAi posts a chat-completions request and parses the verdict', async () => {
  /** @type {any} */
  let seen = null
  const server = await stubServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '{"action":"retry","reason":"transient","hint":"watch","confidence":0.9}' } }] }))
    })
  })
  const port = /** @type {any} */ (server).address().port
  const settings = /** @type {any} */ ({ enabled: true, preset: 'custom', endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: 'test-model', apiKey: 'sk-x', timeoutMs: 5000, keyEnv: 'K', maxLogBytes: 4096 })
  const result = await callAi({ settings, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.verdict.action, 'retry')
  assert.equal(seen.auth, 'Bearer sk-x')
  assert.equal(seen.body.model, 'test-model')
  server.close()
})

test('callAi reports disabled, missing key, HTTP errors and bad payloads', async () => {
  const disabled = await callAi({ settings: /** @type {any} */ ({ enabled: false }), messages: [] })
  assert.equal(disabled.ok, false)

  const noKey = await callAi({ settings: /** @type {any} */ ({ enabled: true, endpoint: 'http://127.0.0.1:1/x', apiKey: '', model: 'm', timeoutMs: 500, preset: 'custom', keyEnv: 'K', maxLogBytes: 4096 }), messages: [] })
  assert.equal(noKey.ok, false)
  if (!noKey.ok) assert.match(noKey.error, /no API key/)

  const server = await stubServer((_req, res) => {
    res.writeHead(500)
    res.end('boom')
  })
  const port = /** @type {any} */ (server).address().port
  const settings = /** @type {any} */ ({ enabled: true, preset: 'custom', endpoint: `http://127.0.0.1:${port}/`, model: 'm', apiKey: 'k', timeoutMs: 2000, keyEnv: 'K', maxLogBytes: 4096 })
  const failed = await callAi({ settings, messages: [] })
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.match(failed.error, /HTTP 500/)
  server.close()
})

test('applyAiVerdict turns a manual plan into a restart, but never over a foreign holder', () => {
  const plan = planFor('module-missing')
  assert.equal(plan.stopReason, 'needs-operator')
  const verdict = { action: 'retry', reason: 'transient', hint: 'try once', confidence: 0.9 }
  const merged = applyAiVerdict(plan, /** @type {any} */ (verdict), { attempt: 1 })
  assert.equal(merged.ok, true)
  assert.equal(merged.applied, true)
  assert.equal(plan.steps.some((item) => item.action === 'manual'), false)
  assert.equal(plan.steps.some((item) => item.action === 'start-dsh'), true)

  const foreign = planFor('port-in-use')
  const blocked = applyAiVerdict(foreign, /** @type {any} */ (verdict), { occupantIsForeign: true })
  assert.equal(blocked.ok, false)
  assert.equal(foreign.steps.some((item) => item.action === 'start-dsh'), false)
})

test('applyAiVerdict respects confidence, hard stops and backup availability', () => {
  const low = applyAiVerdict(planFor('module-missing'), { action: 'retry', reason: '', hint: '', confidence: 0.2 })
  assert.equal(low.ok, false)

  const maintenance = { ...planFor('module-missing'), stopReason: 'maintenance' }
  assert.equal(applyAiVerdict(maintenance, { action: 'retry', reason: '', hint: '', confidence: 1 }).ok, false)

  const noBackups = applyAiVerdict(planFor('module-missing'), { action: 'rollback-patch', reason: '', hint: '', confidence: 1 }, { hasBackups: false })
  assert.equal(noBackups.ok, false)

  const plan = planFor('module-missing')
  const rolled = applyAiVerdict(plan, { action: 'rollback-patch', reason: 'bad yaml', hint: 'backup', confidence: 0.9 }, { hasBackups: true, attempt: 1 })
  assert.equal(rolled.ok, true)
  assert.equal(rolled.applied, true)
  assert.equal(plan.steps[0].action, 'rollback-patch')
  assert.equal(plan.steps.some((item) => item.action === 'start-dsh'), true)
})


test('the key can come from the harness credential store when the env is empty', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-ai-'))
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-from-dsh\n')
  const env = /** @type {any} */ ({ DSH_HOME: home })
  const envOnly = aiSettings(normalizeConfig({ ai: { enabled: true, credentialSource: 'env' } }).config, env)
  assert.equal(envOnly.apiKey, '')
  const enabled = aiSettings(normalizeConfig({ ai: { enabled: true, credentialSource: 'dsh' } }).config, env)
  assert.equal(enabled.apiKey, 'sk-from-dsh')
  assert.equal(enabled.keySource, 'dsh-store')
  assert.equal(enabled.keyName, 'DEEPSEEK_API_KEY')

  const fromEnv = aiSettings(normalizeConfig({ ai: { enabled: true } }).config, { ...env, DEEPSEEK_API_KEY: 'sk-env' })
  assert.equal(fromEnv.apiKey, 'sk-env')
  assert.equal(fromEnv.keySource, 'env')

  const none = aiSettings(normalizeConfig({ ai: { enabled: true, credentialSource: 'none' } }).config, env)
  assert.equal(none.apiKey, '')
})

test('a bridge program turns a prompt on stdin into a verdict without an endpoint', async () => {
  const bridged = normalizeConfig({
    ai: {
      enabled: true,
      bridge: {
        enabled: true,
        program: process.execPath,
        args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({action:"retry",reason:"bridge says retry",hint:"",confidence:0.8})))'],
      },
    },
  }).config
  const settings = aiSettings(bridged, /** @type {any} */ ({}))
  assert.equal(settings.bridge.enabled, true)
  const messages = buildAiRequest({ locale: 'zh', facts: { incident: 'unknown', maxLogBytes: 4096 }, logText: 'boom' }).messages
  const result = await callAi({ settings, messages })
  assert.equal(result.ok, true)
  assert.equal(result.verdict.action, 'retry')

  const broken = aiSettings(
    normalizeConfig({ ai: { enabled: true, bridge: { enabled: true, program: process.execPath, args: ['-e', 'process.exit(2)'] } } }).config,
    /** @type {any} */ ({}),
  )
  const failed = await callBridge({ settings: broken, messages })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /bridge exited 2/)
})

test('act mode is the default and prefers the DSH agent', () => {
  const { config } = normalizeConfig({})
  const settings = aiSettings(config, {})
  assert.equal(settings.mode, 'act')
  assert.equal(settings.order, 'dsh-agent-first')
  assert.equal(settings.dshAgent.enabled, true)
  assert.equal(settings.dshAgent.command, 'dsh')
  assert.deepEqual(settings.dshAgent.args, ['headless'])
})

test('repair prompt carries the environment and the verdict contract', () => {
  const prompt = buildRepairPrompt({
    locale: 'zh',
    environment: '## Environment\n- service: port 3098, port open: no',
    logText: 'startup failed\nAuthorization: Bearer abc.def',
    port: 3098,
    profile: 'web',
    binPath: '/usr/local/bin/dsh',
    logPath: '/tmp/boot.log',
    maxLogBytes: 4096,
  })
  assert.match(prompt, /完全权限/)
  assert.match(prompt, /port 3098, port open: no/)
  assert.match(prompt, /VERDICT \{"action":"fix-plugin/)
  assert.match(prompt, /setsid nohup \/usr\/local\/bin\/dsh web --port 3098/)
  assert.ok(!prompt.includes('abc.def'), 'authorization headers are redacted')
})

/** A tiny ChildProcess stand-in: emits stdout, then closes with a code. */
function fakeSpawn(output, code = 0) {
  (/** @type {any} */ (globalThis)).__fakeSpawnUsesCreateRequire = true
  const { EventEmitter } = createRequire(import.meta.url)('node:events')
  return (_command, _args, _options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
    }
    setTimeout(() => {
      if (output) child.stdout.emit('data', Buffer.from(output))
      child.emit('close', code)
    }, 5)
    return child
  }
}

test('repairWithAi runs the DSH agent first and stops when it acts', async () => {
  const settings = {
    enabled: true,
    order: 'dsh-agent-first',
    dshAgent: { enabled: true, command: 'dsh', args: ['headless'], timeoutMs: 5000 },
    bridge: { enabled: false, program: '', args: [] },
    endpoint: 'https://unused.invalid',
    model: 'm',
    apiKey: 'k',
  }
  let fetched = 0
  const result = await repairWithAi({
    settings,
    prompt: 'fix it',
    profile: 'web',
    spawnImpl: fakeSpawn('working...\nVERDICT {"action":"fixed","reason":"rolled back","hint":"restart later","confidence":0.9}\n'),
    fetchImpl: async () => {
      fetched += 1
      throw new Error('direct call must not run when the agent succeeds')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'dsh-agent')
  assert.equal(result.verdict.action, 'retry')
  assert.equal(result.verdict.fixed, true)
  assert.equal(fetched, 0)
})

test('repairWithAi falls back to the direct call when the agent fails', async () => {
  const settings = {
    enabled: true,
    order: 'dsh-agent-first',
    dshAgent: { enabled: true, command: 'dsh', args: ['headless'], timeoutMs: 5000 },
    bridge: { enabled: false, program: '', args: [] },
    endpoint: 'https://api.test/chat/completions',
    model: 'm',
    apiKey: 'k',
    timeoutMs: 2000,
  }
  const result = await repairWithAi({
    settings,
    prompt: 'fix it',
    profile: 'web',
    spawnImpl: fakeSpawn('', 2),
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"rollback-patch","reason":"patch broke it","hint":"check patch","confidence":0.8}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'model')
  assert.equal(result.verdict.action, 'rollback-patch')
  assert.ok(result.notes.some((note) => note.includes('dsh agent')), 'agent failure is recorded')
})

test('direct-only never starts the DSH agent', async () => {
  const settings = {
    enabled: true,
    order: 'direct-only',
    dshAgent: { enabled: true, command: 'dsh', args: ['headless'], timeoutMs: 5000 },
    endpoint: 'https://api.test/chat/completions',
    model: 'm',
    apiKey: 'k',
    timeoutMs: 2000,
  }
  const result = await repairWithAi({
    settings,
    prompt: 'fix it',
    spawnImpl: () => {
      throw new Error('the agent must not run in direct-only mode')
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"manual","reason":"needs human","hint":"look","confidence":0.7}' } }] }), { status: 200 }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.via, 'model')
  assert.equal(result.verdict.action, 'manual')
})

test('parseVerdict: fix-plugin edits are validated and bounded', () => {
  const ok = parseVerdict('VERDICT {"action":"fix-plugin","edits":[{"file":"demo-config.json","content":"{\\"enabled\\":true}"}],"reason":"flip","hint":"","confidence":0.9}')
  assert.equal(ok.ok, true)
  assert.equal(/** @type {any} */ (ok).verdict.action, 'fix-plugin')
  assert.equal(/** @type {any} */ (ok).verdict.edits.length, 1)

  const absolute = parseVerdict('VERDICT {"action":"fix-plugin","edits":[{"file":"/etc/passwd","content":"x"}]}')
  assert.equal(absolute.ok, false)
  assert.match(/** @type {any} */ (absolute).error, /must stay inside the plugin directory/)

  const dotdot = parseVerdict('VERDICT {"action":"fix-plugin","edits":[{"file":"../x.js","content":"x"}]}')
  assert.equal(dotdot.ok, false)

  const four = parseVerdict(`VERDICT {"action":"fix-plugin","edits":[${Array.from({ length: 4 }, (_, i) => `{"file":"f${i}.js","content":"x"}`).join(',')}]}`)
  assert.equal(four.ok, false)
  assert.match(/** @type {any} */ (four).error, /1-3 edits/)

  const disable = parseVerdict('VERDICT {"action":"disable-plugin","reason":"broken"}')
  assert.equal(disable.ok, false)
  assert.match(/** @type {any} */ (disable).error, /entryId/)
})

test('applyAiVerdict: fix-plugin replaces the manual stop with an AI fix step', () => {
  const plan = planFor('module-missing')
  assert.ok(plan.steps.some((item) => item.action === 'manual'))
  const merged = applyAiVerdict(
    plan,
    { action: 'fix-plugin', edits: [{ file: 'demo-config.json', content: '{"enabled":true}' }], reason: 'flip', hint: '', confidence: 0.9 },
    { entryName: 'demo-broken', corePackage: false },
  )
  assert.equal(merged.ok, true)
  assert.equal(merged.applied, true)
  assert.equal(plan.steps[0].action, 'fix-plugin')
  assert.ok(plan.steps.some((item) => item.action === 'start-dsh'))
  assert.equal(plan.stopReason, 'ai-fix')
  assert.ok(!plan.steps.some((item) => item.action === 'manual'))
})

test('applyAiVerdict: core packages and disable-plugin', () => {
  const core = planFor('module-missing')
  const refused = applyAiVerdict(
    core,
    { action: 'fix-plugin', edits: [{ file: 'index.js', content: 'x' }], reason: 'fix', hint: '', confidence: 0.9 },
    { entryName: '@deepseek-ai/dsh-base', corePackage: true },
  )
  assert.equal(refused.applied, false)

  const plan = planFor('module-missing')
  const disabled = applyAiVerdict(
    plan,
    { action: 'disable-plugin', entryId: 'demo-broken', reason: 'disable', hint: '', confidence: 0.8 },
    { entryName: 'demo-broken' },
  )
  assert.equal(disabled.applied, true)
  assert.equal(plan.steps[0].action, 'disable-plugin')
  assert.equal(plan.stopReason, 'ai-disable')
})

test('buildRepairPrompt: plugin material is included before the log tail', () => {
  const prompt = buildRepairPrompt({
    locale: 'zh',
    environment: '- host: demo',
    logText: 'boom',
    port: 3098,
    profile: 'web',
    binPath: '/usr/local/bin/dsh',
    logPath: '/tmp/boot.log',
    material: '## Failing plugin\n- entry: modules (required)\n',
  })
  assert.ok(prompt.includes('## Failing plugin'))
  assert.ok(prompt.indexOf('## Failing plugin') < prompt.indexOf('boom'))
})
