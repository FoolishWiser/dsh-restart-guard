// @ts-check
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import {
  AI_PRESETS,
  aiSettings,
  applyAiVerdict,
  buildAiRequest,
  callAi,
  extractJson,
  parseVerdict,
} from '../lib/shared/ai.js'
import { normalizeConfig } from '../lib/shared/config.js'
import { planRepairSteps } from '../lib/shared/plan.js'

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
  assert.equal(off.apiKey, '')

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
