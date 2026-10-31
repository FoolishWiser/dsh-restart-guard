// @ts-check
/**
 * Central redaction. Every string that leaves the process — log file, state
 * file read by the UI, webhook body, IM message, ALERT.md — goes through these
 * helpers first. The rules are deliberately blunt: a false positive costs a
 * masked word, a false negative leaks a launch token or a webhook secret.
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** @type {ReadonlyArray<[RegExp, string]>} */
const RULES = [
  // ?token=..., &token=..., token: "...", ,token=...
  [/(\btoken\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{6,})/gi, '$1***'],
  // URL query / path segment named token
  [/([?&;]token=)([^&\s"'<>]{4,})/gi, '$1***'],
  // Authorization / Cookie headers (mask the whole value, not just the scheme)
  [/((?:authorization|proxy-authorization)\s*[:=]\s*)([^\n]+)/gi, '$1***'],
  [/((?:set-)?cookie["']?\s*[:=]\s*["']?)([^"'\n,}]+)/gi, '$1***'],
  // JSON / YAML fields whose name says "secret"
  [
    /((["']?)(?:token|secret|password|passwd|pwd|credentials?|api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|client[_-]?secret|cookie|authorization|signature)\2\s*:\s*["']?)([^"'\n,}]{3,})/gi,
    '$1***',
  ],
  // Shell-style env assignments: DSH_TOKEN=..., API_KEY=...
  [/(\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_KEY)\s*=\s*)([^\s"'&]+)/g, '$1***'],
  // Generic secret-ish key = value
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|client[_-]?secret|secret|password|passwd|pwd|credential[s]?)\s*[:=]\s*["']?)([^\s"',;&]{3,})/gi,
    '$1***',
  ],
  // Slack / Discord / GitHub style tokens
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g, 'xox*-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh*_***'],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'jwt.***'],
  // Webhook URL query secrets (DingTalk/WeCom/Feishu all use one)
  [/([?&](?:key|access_token|hook_id|auth)=)([^&\s"'<>]{4,})/gi, '$1***'],
]

const SENSITIVE_KEY = /(token|secret|password|passwd|pwd|credential|api[_-]?key|authorization|cookie|signature)/i

/** @param {string} text */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '')
}

/**
 * @param {string} text
 * @param {{ secrets?: Iterable<string> }} [options]
 */
export function redactText(text, options = {}) {
  let out = stripAnsi(String(text ?? ''))
  for (const secret of options.secrets ?? []) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('***')
  }
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

/** @param {string} name */
export function isSensitiveKey(name) {
  return SENSITIVE_KEY.test(String(name ?? ''))
}

/**
 * Persist argv without secrets: `--token=abc` becomes `--token=***`, and a
 * standalone value that follows a sensitive flag is masked too.
 * @param {readonly string[]} argv
 */
export function redactArgv(argv) {
  /** @type {string[]} */
  const out = []
  let maskNext = false
  for (const raw of argv ?? []) {
    const item = String(raw)
    if (maskNext) {
      out.push('***')
      maskNext = false
      continue
    }
    const flag = /^--?([A-Za-z0-9_.-]+)(?:=(.*))?$/.exec(item)
    if (flag && isSensitiveKey(flag[1])) {
      out.push(flag[2] !== undefined ? `${item.slice(0, item.indexOf('=') + 1)}***` : item)
      maskNext = flag[2] === undefined
      continue
    }
    out.push(redactText(item))
  }
  return out
}

/**
 * Never echo a configured webhook URL: it is a bearer secret in most presets.
 * @param {string} url
 */
export function maskUrl(url) {
  const text = String(url ?? '').trim()
  if (!text) return ''
  try {
    const parsed = new URL(text)
    return `${parsed.protocol}//${parsed.host}/***`
  } catch {
    return '***'
  }
}

/**
 * @param {Record<string, unknown>} env
 * @returns {string[]} sorted key names only — values never leave the process
 */
export function envKeyNames(env) {
  return Object.keys(env ?? {}).sort()
}

/**
 * Deep clone of the config with secrets masked, safe for the settings page and
 * for `guard status` output.
 * @param {Record<string, any>} config
 * @param {{ webhookUrl?: string }} [options]
 */
export function redactConfig(config, options = {}) {
  /** @type {Record<string, any>} */
  const out = JSON.parse(JSON.stringify(config ?? {}))
  if (out.notify?.webhook) {
    out.notify.webhook.url = maskUrl(String(options.webhookUrl || out.notify.webhook.url || ''))
    if (out.notify.webhook.secret) out.notify.webhook.secret = '***'
    if (out.notify.webhook.headers) {
      /** @type {Record<string, string>} */
      const headers = {}
      for (const [name, value] of Object.entries(out.notify.webhook.headers)) {
        headers[name] = isSensitiveKey(name) ? '***' : String(value)
      }
      out.notify.webhook.headers = headers
    }
  }
  if (out.notify?.im?.botId) out.notify.im.botId = maskTail(String(out.notify.im.botId))
  return out
}

/** @param {string} value */
function maskTail(value) {
  const text = String(value)
  if (text.length <= 4) return '***'
  return `${text.slice(0, 2)}***${text.slice(-2)}`
}

/**
 * Last N lines, redacted and capped — the shape every notification uses.
 * @param {string} text
 * @param {number} lines
 * @param {number} [maxChars]
 */
export function tailForReport(text, lines, maxChars = 4000) {
  const clean = redactText(text).replace(/\r/g, '')
  const all = clean.split('\n').filter((line, index, arr) => line.length > 0 || index < arr.length - 1)
  const tail = all.slice(Math.max(0, all.length - Math.max(0, lines))).join('\n')
  return tail.length > maxChars ? `${tail.slice(0, maxChars)}\n…` : tail
}
