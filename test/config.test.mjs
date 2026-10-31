// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CONFIG_VERSION,
  DEFAULTS,
  WEBHOOK_PRESETS,
  deepMerge,
  imCredentials,
  loadConfig,
  normalizeConfig,
  resolveLocale,
  saveConfig,
  webhookUrl,
} from '../lib/shared/config.js'

const tmpEnv = () => ({ DSH_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-cfg-')) })

test('defaults are complete and round-trip through normalizeConfig', () => {
  const { config, issues } = normalizeConfig({})
  assert.deepEqual(issues, [])
  assert.equal(config.schemaVersion, CONFIG_VERSION)
  assert.equal(config.enabled, true)
  assert.equal(config.watchdog.maxRestartAttempts, 2)
  assert.equal(config.notify.webhook.preset, 'generic')
  assert.equal(config.readiness.accessLine, 'dsh web:')
  assert.equal(config.retention.incidents, 50)
  assert.deepEqual(config.watchdog.crashLoop, DEFAULTS.watchdog.crashLoop)
})

test('normalizeConfig rejects out-of-range values and reports issues', () => {
  const { config, issues } = normalizeConfig({
    watchdog: { probeIntervalMs: 1, maxRestartAttempts: 99 },
    locale: 'de',
    retention: { incidents: -3 },
  })
  assert.equal(config.watchdog.probeIntervalMs, 2000)
  assert.equal(config.watchdog.maxRestartAttempts, 2)
  assert.equal(config.locale, 'auto')
  assert.equal(config.retention.incidents, 50)
  assert.ok(issues.some((issue) => issue.includes('watchdog.probeIntervalMs')))
  assert.ok(issues.some((issue) => issue.includes('locale')))
})

test('unknown top-level keys survive a save/load round trip', () => {
  const env = tmpEnv()
  saveConfig({ futureFeature: { a: 1 } }, { env })
  const raw = JSON.parse(fs.readFileSync(path.join(env.DSH_HOME, 'restart-guard', 'config.json'), 'utf8'))
  assert.deepEqual(raw.futureFeature, { a: 1 })
  const loaded = loadConfig({ env })
  assert.equal(loaded.exists, true)
  assert.equal(loaded.config.enabled, true)
})

test('saveConfig merges patches instead of replacing the file', () => {
  const env = tmpEnv()
  saveConfig({ notify: { webhook: { enabled: true, url: 'https://example.test/hook' } } }, { env })
  saveConfig({ watchdog: { maxRestartAttempts: 1 } }, { env })
  const loaded = loadConfig({ env })
  assert.equal(loaded.config.notify.webhook.enabled, true)
  assert.equal(loaded.config.notify.webhook.url, 'https://example.test/hook')
  assert.equal(loaded.config.watchdog.maxRestartAttempts, 1)
  const mode = fs.statSync(loaded.path).mode & 0o777
  assert.equal(mode, 0o600)
})

test('webhook URL and IM credentials prefer environment variables', () => {
  const env = { DSH_RESTART_GUARD_WEBHOOK_URL: 'https://env.test/hook' }
  assert.equal(webhookUrl({ notify: { webhook: { url: 'https://cfg.test/hook' } } }, env), 'https://env.test/hook')
  assert.equal(webhookUrl({ notify: { webhook: { url: 'https://cfg.test/hook' } } }, {}), 'https://cfg.test/hook')
  const creds = imCredentials(
    { notify: { im: { botId: 'bot', targetId: 'target' } } },
    { DSH_RESTART_GUARD_IM_BOT_ID: 'envbot' },
  )
  assert.equal(creds.botId, 'envbot')
  assert.equal(creds.targetId, 'target')
})

test('resolveLocale follows config, then environment', () => {
  assert.equal(resolveLocale({ locale: 'en' }, {}), 'en')
  assert.equal(resolveLocale({ locale: 'zh' }, { LANG: 'en_US.UTF-8' }), 'zh')
  assert.equal(resolveLocale({ locale: 'auto' }, { DSH_RESTART_GUARD_LOCALE: 'en' }), 'en')
  assert.equal(resolveLocale({ locale: 'auto' }, { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveLocale({ locale: 'auto' }, { LANG: 'fr_FR.UTF-8' }), 'en')
})

test('deepMerge keeps defaults for omitted keys', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })
  assert.deepEqual(merged, { a: { b: 1, c: 3 } })
  assert.deepEqual(deepMerge({ a: [1] }, { a: [2] }), { a: [2] })
})

test('preset list is stable', () => {
  assert.deepEqual(WEBHOOK_PRESETS, [
    'generic',
    'feishu',
    'wecom',
    'dingtalk',
    'slack',
    'telegram',
    'discord',
    'ntfy',
    'healthchecks',
  ])
})
