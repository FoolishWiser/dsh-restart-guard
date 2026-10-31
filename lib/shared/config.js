// @ts-check
/**
 * Configuration schema, defaults, validation, migration and persistence.
 *
 * The guard keeps one config file per DSH home (`$DSH_HOME/restart-guard/config.json`).
 * Instances (one per profile+port) share it on purpose: notification channels and
 * safety switches are deployment-wide decisions, while the launch plan, boot log
 * offset and incident history are per instance.
 */
import fs from 'node:fs'
import { dirname } from 'node:path'
import { configPath, ensureDir, expandHome, readJson, writeJsonAtomic } from './paths.js'

export const CONFIG_VERSION = 1

/** @typedef {{ schemaVersion: number, enabled: boolean, locale: 'auto'|'zh'|'en', watchdog: Record<string, any>, arbitration: Record<string, any>, maintenance: Record<string, any>, readiness: Record<string, any>, launch: Record<string, any>, logs: Record<string, any>, notify: Record<string, any>, ai: Record<string, any>, security: Record<string, any>, retention: Record<string, any> }} GuardConfig */

/** @type {GuardConfig} */
export const DEFAULTS = {
  schemaVersion: CONFIG_VERSION,
  enabled: true,
  locale: 'auto',
  watchdog: {
    probeIntervalMs: 2000,
    probeTimeoutMs: 3000,
    startupGraceMs: 30000,
    bootTimeoutMs: 120000,
    bootRetryTimeoutMs: 180000,
    settleMs: 5000,
    stalledExitMs: 20000,
    maxRestartAttempts: 2,
    rollbackProfilePatch: true,
    killStaleDshHolder: false,
    respectIntentionalStop: true,
    adoptedPidCheckMs: 1500,
    crashLoop: { windowMs: 600000, maxIncidents: 3, pauseMs: 1800000 },
  },
  arbitration: {
    extraGraceMs: 30000,
    maxExtensions: 2,
    restarterPatterns: [
      'restart[-_.]?dsh',
      'cutover\\.sh',
      'restore-core\\.sh',
      'selfupdate',
      'restart-dsh-web',
    ],
  },
  maintenance: {
    autoDetect: true,
    graceMs: 900000,
    lookbackMs: 1800000,
    upgradeRoots: ['$DSH_HOME/upgrade'],
    standDownOnTreeChange: true,
  },
  readiness: {
    // The web server prints this line right after a successful boot; the token on
    // the same line is what proves the process really finished starting.
    accessLine: 'dsh web:',
    strictAudit: true,
    fatalPatterns: [
      'failed to mount',
      'Cannot find module',
      'disabling profile plugin',
      'StartupError',
      'did not activate',
      'pending \\(waiting',
    ],
    inferredSettleMs: 15000,
    maxReadBytes: 1048576,
  },
  launch: {
    mode: 'argv',
    command: null,
    binPath: '',
    appendArgs: ['--no-open'],
  },
  logs: {
    bootLogPath: '',
    maxBytes: 5242880,
    keep: 2,
    maxTailLines: 40,
  },
  notify: {
    throttleMs: 60000,
    includeLogTailLines: 40,
    includeAccessUrl: false,
    includeHostInfo: false,
    includeLaunchToken: false,
    webhook: {
      enabled: false,
      preset: 'generic',
      url: '',
      secret: '',
      headers: {},
      chatId: '',
    },
    command: {
      enabled: false,
      program: '',
      args: [],
    },
    im: {
      enabled: false,
      botId: '',
      targetId: '',
      format: 'markdown',
    },
  },
  ai: {
    enabled: false,
    preset: 'deepseek',
    endpoint: '',
    model: '',
    keyEnv: 'DEEPSEEK_API_KEY',
    timeoutMs: 20000,
    maxLogBytes: 8192,
  },
  security: {
    allowRemoteMutations: false,
    dangerousActions: false,
  },
  retention: {
    incidents: 50,
    outboxHours: 24,
  },
}

const WEBHOOK_PRESETS = [
  'generic',
  'feishu',
  'wecom',
  'dingtalk',
  'slack',
  'telegram',
  'discord',
  'ntfy',
  'healthchecks',
]

/** @param {unknown} base @param {unknown} patch */
export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return clone(base)
  if (Array.isArray(base) || Array.isArray(patch)) return clone(patch)
  if (typeof base !== 'object' || typeof patch !== 'object') return clone(patch)
  /** @type {Record<string, unknown>} */
  const out = { .../** @type {Record<string, unknown>} */ (base) }
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (patch))) {
    const current = out[key]
    out[key] = current && typeof current === 'object' && value && typeof value === 'object'
      ? deepMerge(current, value)
      : clone(value)
  }
  return out
}

/** @param {unknown} value */
function clone(value) {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value))
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max @param {string} key @param {string[]} issues */
function numberField(value, fallback, min, max, key, issues) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    issues.push(`${key}: expected a number in [${min}, ${max}], kept ${fallback}`)
    return fallback
  }
  return Math.round(n)
}

/** @param {unknown} value @param {boolean} fallback @param {string} key @param {string[]} issues */
function boolField(value, fallback, key, issues) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  issues.push(`${key}: expected a boolean, kept ${fallback}`)
  return fallback
}

/** @param {unknown} value @param {string} fallback @param {string} key @param {string[]} issues */
function stringField(value, fallback, key, issues) {
  if (value === undefined) return fallback
  if (typeof value === 'string') return value
  issues.push(`${key}: expected a string, kept the previous value`)
  return fallback
}

/** @param {unknown} value @param {string} fallback @param {readonly string[]} allowed @param {string} key @param {string[]} issues */
function enumField(value, fallback, allowed, key, issues) {
  if (value === undefined) return fallback
  const text = String(value)
  if (!allowed.includes(text)) {
    issues.push(`${key}: expected one of ${allowed.join(', ')}, kept ${fallback}`)
    return fallback
  }
  return text
}

/** @param {unknown} value @param {readonly string[]} fallback @param {string} key @param {string[]} issues */
function stringArray(value, fallback, key, issues) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    issues.push(`${key}: expected an array of strings, kept the default`)
    return [...fallback]
  }
  return value.map((item) => String(item)).filter((item) => item.trim() !== '')
}

/** @param {unknown} value @param {Record<string, string>} fallback @param {string} key @param {string[]} issues */
function stringMap(value, fallback, key, issues) {
  if (value === undefined) return { ...fallback }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${key}: expected an object of strings, kept the default`)
    return { ...fallback }
  }
  /** @type {Record<string, string>} */
  const out = {}
  for (const [name, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (typeof raw === 'string') out[name] = raw
  }
  return out
}

/**
 * Merge a user-supplied fragment over the defaults, then validate every known
 * field. Unknown keys are preserved so a newer version can write config a newer
 * guard understands.
 * @param {unknown} input
 * @returns {{ config: GuardConfig, issues: string[] }}
 */
export function normalizeConfig(input) {
  /** @type {string[]} */
  const issues = []
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const version = /** @type {Record<string, any>} */ (source).schemaVersion
  if (version !== undefined && Number(version) > CONFIG_VERSION) {
    issues.push(`schemaVersion ${version} is newer than ${CONFIG_VERSION}; loading best effort`)
  }
  const merged = /** @type {Record<string, any>} */ (deepMerge(DEFAULTS, source))
  const cfg = /** @type {GuardConfig} */ (merged)

  cfg.schemaVersion = CONFIG_VERSION
  cfg.enabled = boolField(cfg.enabled, DEFAULTS.enabled, 'enabled', issues)
  cfg.locale = /** @type {GuardConfig['locale']} */ (
    enumField(cfg.locale, DEFAULTS.locale, ['auto', 'zh', 'en'], 'locale', issues)
  )

  cfg.watchdog.probeIntervalMs = numberField(cfg.watchdog.probeIntervalMs, 2000, 500, 60000, 'watchdog.probeIntervalMs', issues)
  cfg.watchdog.probeTimeoutMs = numberField(cfg.watchdog.probeTimeoutMs, 3000, 200, 30000, 'watchdog.probeTimeoutMs', issues)
  cfg.watchdog.startupGraceMs = numberField(cfg.watchdog.startupGraceMs, 30000, 1000, 600000, 'watchdog.startupGraceMs', issues)
  cfg.watchdog.bootTimeoutMs = numberField(cfg.watchdog.bootTimeoutMs, 120000, 5000, 900000, 'watchdog.bootTimeoutMs', issues)
  cfg.watchdog.bootRetryTimeoutMs = numberField(cfg.watchdog.bootRetryTimeoutMs, 180000, 5000, 1800000, 'watchdog.bootRetryTimeoutMs', issues)
  cfg.watchdog.settleMs = numberField(cfg.watchdog.settleMs, 5000, 0, 120000, 'watchdog.settleMs', issues)
  cfg.watchdog.stalledExitMs = numberField(cfg.watchdog.stalledExitMs, 20000, 1000, 600000, 'watchdog.stalledExitMs', issues)
  cfg.watchdog.maxRestartAttempts = numberField(cfg.watchdog.maxRestartAttempts, 2, 0, 10, 'watchdog.maxRestartAttempts', issues)
  cfg.watchdog.rollbackProfilePatch = boolField(cfg.watchdog.rollbackProfilePatch, true, 'watchdog.rollbackProfilePatch', issues)
  cfg.watchdog.killStaleDshHolder = boolField(cfg.watchdog.killStaleDshHolder, false, 'watchdog.killStaleDshHolder', issues)
  cfg.watchdog.respectIntentionalStop = boolField(cfg.watchdog.respectIntentionalStop, true, 'watchdog.respectIntentionalStop', issues)
  cfg.watchdog.crashLoop.windowMs = numberField(cfg.watchdog.crashLoop.windowMs, 600000, 60000, 86400000, 'watchdog.crashLoop.windowMs', issues)
  cfg.watchdog.crashLoop.maxIncidents = numberField(cfg.watchdog.crashLoop.maxIncidents, 3, 1, 100, 'watchdog.crashLoop.maxIncidents', issues)
  cfg.watchdog.crashLoop.pauseMs = numberField(cfg.watchdog.crashLoop.pauseMs, 1800000, 60000, 86400000, 'watchdog.crashLoop.pauseMs', issues)

  cfg.arbitration.extraGraceMs = numberField(cfg.arbitration.extraGraceMs, 30000, 0, 300000, 'arbitration.extraGraceMs', issues)
  cfg.arbitration.maxExtensions = numberField(cfg.arbitration.maxExtensions, 2, 0, 10, 'arbitration.maxExtensions', issues)
  cfg.arbitration.restarterPatterns = stringArray(cfg.arbitration.restarterPatterns, DEFAULTS.arbitration.restarterPatterns, 'arbitration.restarterPatterns', issues)
  for (const pattern of cfg.arbitration.restarterPatterns) {
    try {
      new RegExp(pattern)
    } catch {
      issues.push(`arbitration.restarterPatterns: invalid regular expression ${JSON.stringify(pattern)}`)
    }
  }

  cfg.maintenance.autoDetect = boolField(cfg.maintenance.autoDetect, true, 'maintenance.autoDetect', issues)
  cfg.maintenance.graceMs = numberField(cfg.maintenance.graceMs, 900000, 1000, 86400000, 'maintenance.graceMs', issues)
  cfg.maintenance.lookbackMs = numberField(cfg.maintenance.lookbackMs, 1800000, 1000, 86400000, 'maintenance.lookbackMs', issues)
  cfg.maintenance.upgradeRoots = stringArray(cfg.maintenance.upgradeRoots, DEFAULTS.maintenance.upgradeRoots, 'maintenance.upgradeRoots', issues)
    .map((root) => expandHome(root))
  cfg.maintenance.standDownOnTreeChange = boolField(cfg.maintenance.standDownOnTreeChange, true, 'maintenance.standDownOnTreeChange', issues)

  cfg.readiness.accessLine = stringField(cfg.readiness.accessLine, 'dsh web:', 'readiness.accessLine', issues)
  cfg.readiness.strictAudit = boolField(cfg.readiness.strictAudit, true, 'readiness.strictAudit', issues)
  cfg.readiness.fatalPatterns = stringArray(cfg.readiness.fatalPatterns, DEFAULTS.readiness.fatalPatterns, 'readiness.fatalPatterns', issues)
  cfg.readiness.inferredSettleMs = numberField(cfg.readiness.inferredSettleMs, 15000, 1000, 300000, 'readiness.inferredSettleMs', issues)
  cfg.readiness.maxReadBytes = numberField(cfg.readiness.maxReadBytes, 1048576, 4096, 16777216, 'readiness.maxReadBytes', issues)

  cfg.launch.mode = enumField(cfg.launch.mode, 'argv', ['argv', 'command'], 'launch.mode', issues)
  cfg.launch.binPath = stringField(cfg.launch.binPath, '', 'launch.binPath', issues)
  cfg.launch.appendArgs = stringArray(cfg.launch.appendArgs, ['--no-open'], 'launch.appendArgs', issues)
  if (cfg.launch.command !== null && cfg.launch.command !== undefined) {
    const command = cfg.launch.command
    if (!command || typeof command !== 'object' || typeof command.program !== 'string' || !command.program.trim()) {
      issues.push('launch.command: expected { program, args[] }; falling back to argv mode')
      cfg.launch.mode = 'argv'
      cfg.launch.command = null
    } else if (!Array.isArray(command.args) || command.args.some((/** @type {unknown} */ item) => typeof item !== 'string')) {
      issues.push('launch.command.args: expected an array of strings')
      cfg.launch.command = { program: command.program, args: [] }
    }
  }

  cfg.logs.bootLogPath = stringField(cfg.logs.bootLogPath, '', 'logs.bootLogPath', issues)
  cfg.logs.maxBytes = numberField(cfg.logs.maxBytes, 5242880, 65536, 104857600, 'logs.maxBytes', issues)
  cfg.logs.keep = numberField(cfg.logs.keep, 2, 1, 10, 'logs.keep', issues)
  cfg.logs.maxTailLines = numberField(cfg.logs.maxTailLines, 40, 0, 500, 'logs.maxTailLines', issues)

  cfg.notify.throttleMs = numberField(cfg.notify.throttleMs, 60000, 0, 3600000, 'notify.throttleMs', issues)
  cfg.notify.includeLogTailLines = numberField(cfg.notify.includeLogTailLines, 40, 0, 500, 'notify.includeLogTailLines', issues)
  cfg.notify.includeAccessUrl = boolField(cfg.notify.includeAccessUrl, false, 'notify.includeAccessUrl', issues)
  cfg.notify.includeHostInfo = boolField(cfg.notify.includeHostInfo, false, 'notify.includeHostInfo', issues)
  cfg.notify.includeLaunchToken = boolField(cfg.notify.includeLaunchToken, false, 'notify.includeLaunchToken', issues)

  cfg.notify.webhook.enabled = boolField(cfg.notify.webhook.enabled, false, 'notify.webhook.enabled', issues)
  cfg.notify.webhook.preset = enumField(cfg.notify.webhook.preset, 'generic', WEBHOOK_PRESETS, 'notify.webhook.preset', issues)
  cfg.notify.webhook.url = stringField(cfg.notify.webhook.url, '', 'notify.webhook.url', issues)
  cfg.notify.webhook.secret = stringField(cfg.notify.webhook.secret, '', 'notify.webhook.secret', issues)
  cfg.notify.webhook.headers = stringMap(cfg.notify.webhook.headers, {}, 'notify.webhook.headers', issues)
  cfg.notify.webhook.chatId = stringField(cfg.notify.webhook.chatId, '', 'notify.webhook.chatId', issues)

  cfg.notify.command.enabled = boolField(cfg.notify.command.enabled, false, 'notify.command.enabled', issues)
  cfg.notify.command.program = stringField(cfg.notify.command.program, '', 'notify.command.program', issues)
  cfg.notify.command.args = stringArray(cfg.notify.command.args, [], 'notify.command.args', issues)

  cfg.notify.im.enabled = boolField(cfg.notify.im.enabled, false, 'notify.im.enabled', issues)
  cfg.notify.im.botId = stringField(cfg.notify.im.botId, '', 'notify.im.botId', issues)
  cfg.notify.im.targetId = stringField(cfg.notify.im.targetId, '', 'notify.im.targetId', issues)
  cfg.notify.im.format = enumField(cfg.notify.im.format, 'markdown', ['markdown', 'text'], 'notify.im.format', issues)

  cfg.ai.enabled = boolField(cfg.ai.enabled, false, 'ai.enabled', issues)
  cfg.ai.preset = enumField(cfg.ai.preset, 'deepseek', ['deepseek', 'openai', 'custom'], 'ai.preset', issues)
  cfg.ai.endpoint = stringField(cfg.ai.endpoint, '', 'ai.endpoint', issues)
  cfg.ai.model = stringField(cfg.ai.model, '', 'ai.model', issues)
  cfg.ai.keyEnv = stringField(cfg.ai.keyEnv, 'DEEPSEEK_API_KEY', 'ai.keyEnv', issues)
  cfg.ai.timeoutMs = numberField(cfg.ai.timeoutMs, 20000, 2000, 120000, 'ai.timeoutMs', issues)
  cfg.ai.maxLogBytes = numberField(cfg.ai.maxLogBytes, 8192, 1024, 65536, 'ai.maxLogBytes', issues)

  cfg.security.allowRemoteMutations = boolField(cfg.security.allowRemoteMutations, false, 'security.allowRemoteMutations', issues)
  cfg.security.dangerousActions = boolField(cfg.security.dangerousActions, false, 'security.dangerousActions', issues)

  cfg.retention.incidents = numberField(cfg.retention.incidents, 50, 1, 1000, 'retention.incidents', issues)
  cfg.retention.outboxHours = numberField(cfg.retention.outboxHours, 24, 1, 720, 'retention.outboxHours', issues)

  return { config: cfg, issues }
}

/**
 * Load the config file (or defaults when absent) and report its freshness.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function loadConfig({ env = process.env } = {}) {
  const file = configPath(env)
  const raw = readJson(file, null)
  const { config, issues } = normalizeConfig(raw ?? {})
  const stat = (() => {
    try {
      return fs.statSync(file)
    } catch {
      return null
    }
  })()
  return {
    config,
    issues,
    path: file,
    exists: raw !== null,
    mtimeMs: stat?.mtimeMs ?? 0,
    env,
  }
}

/**
 * Merge `patch` into the on-disk config (or defaults) and write it back.
 * @param {unknown} patch
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function saveConfig(patch, { env = process.env } = {}) {
  const file = configPath(env)
  const raw = readJson(file, null)
  const merged = deepMerge(raw ?? {}, patch)
  const { config, issues } = normalizeConfig(merged)
  ensureDir(dirname(file), 0o700)
  writeJsonAtomic(file, config, 0o600)
  return { config, issues, path: file }
}

/**
 * Prefer the environment variable so a webhook URL can stay out of the config
 * file entirely; it is otherwise a stored secret.
 * @param {Record<string, any>} config
 * @param {NodeJS.ProcessEnv} [env]
 */
export function webhookUrl(config, env = process.env) {
  const fromEnv = typeof env.DSH_RESTART_GUARD_WEBHOOK_URL === 'string' ? env.DSH_RESTART_GUARD_WEBHOOK_URL.trim() : ''
  return fromEnv || String(config?.notify?.webhook?.url ?? '').trim()
}

/**
 * @param {Record<string, any>} config
 * @param {NodeJS.ProcessEnv} [env]
 */
export function imCredentials(config, env = process.env) {
  const botId = String(env.DSH_RESTART_GUARD_IM_BOT_ID ?? config?.notify?.im?.botId ?? '').trim()
  const targetId = String(env.DSH_RESTART_GUARD_IM_TARGET_ID ?? config?.notify?.im?.targetId ?? '').trim()
  return { botId, targetId }
}

/**
 * @param {Record<string, any>} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'zh'|'en'}
 */
export function resolveLocale(config, env = process.env) {
  const configured = String(config?.locale ?? 'auto')
  if (configured === 'zh' || configured === 'en') return configured
  const probe = String(env.DSH_RESTART_GUARD_LOCALE ?? env.DSH_LOCALE ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '')
  return /^zh/i.test(probe) ? 'zh' : 'en'
}

export { WEBHOOK_PRESETS }
