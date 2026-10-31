// @ts-check
/**
 * Notification fan-out.
 *
 * Delivery is best-effort and never allowed to break the watch loop: every
 * channel is wrapped in a timeout and its failure is recorded, not thrown.
 * Nothing leaves the machine unless the operator configured a channel — the
 * log file is the only always-on sink.
 */
import { spawn } from 'node:child_process'
import { appendOutbox } from './state.js'
import { redactText, tailForReport } from './redact.js'
import { webhookUrl, imCredentials } from './config.js'

/**
 * @typedef {{
 *   title: string,
 *   summary: string,
 *   severity: 'info'|'warning'|'error',
 *   marks: Record<string, string|number|boolean>,
 *   logTail: string,
 *   markdown: string,
 * }} Report
 */

/** @type {Record<string, Record<string, string>>} */
const TEXT = {
  zh: {
    down: 'DSH Web 无响应',
    'down.body': '端口 {port} 连续 {downSec} 秒无法访问 DSH（{kind}）。',
    repairStarted: '正在尝试修复',
    'repairStarted.body': '判定：{incident}（{detail}）。计划：{plan}',
    repairing: '已开始重启 DSH',
    'repairing.body': '使用捕获的启动参数重启（第 {attempt} 次），等待访问行出现。',
    repaired: 'DSH 已恢复',
    'repaired.body': '端口 {port} 已恢复（耗时 {elapsed} 秒）。{note}',
    repairFailed: '自动修复失败，需要人工介入',
    'repairFailed.body': '判定：{incident}（{detail}）。停止原因：{stopReason}。\n下一步：{hint}',
    manual: '需要人工处理',
    'manual.body': '判定：{incident}（{detail}）。\n下一步：{hint}',
    maintenance: '检测到维护/升级，守护待命',
    'maintenance.body': '信号：{signals}\n维护窗口内不会启动、回滚或终止任何进程。窗口截止：{until}',
    supervised: '检测到进程监督者，只报告不处理',
    'supervised.body': '{detail}\n请由监督者或人工重启，守护不会抢占端口。',
    flapping: '重启风暴，守护已暂停',
    'flapping.body': '窗口 {windowMin} 分钟内失败 {count} 次，已暂停到 {until}。',
    test: '重启守护测试消息',
    'test.body': '渠道配置可用。端口 {port}，当前状态 {phase}。',
    logTail: '日志尾部',
    titlePrefix: '重启守护',
  },
  en: {
    down: 'DSH Web is not responding',
    'down.body': 'DSH was unreachable on port {port} for {downSec}s ({kind}).',
    repairStarted: 'Attempting a repair',
    'repairStarted.body': 'Diagnosis: {incident} ({detail}). Plan: {plan}',
    repairing: 'Restarting DSH',
    'repairing.body': 'Restarting with the captured launch spec (attempt {attempt}), waiting for the access line.',
    repaired: 'DSH is back',
    'repaired.body': 'Port {port} answered again after {elapsed}s. {note}',
    repairFailed: 'Automatic repair failed — operator required',
    'repairFailed.body': 'Diagnosis: {incident} ({detail}). Stop reason: {stopReason}.\nNext step: {hint}',
    manual: 'Operator action required',
    'manual.body': 'Diagnosis: {incident} ({detail}).\nNext step: {hint}',
    maintenance: 'Maintenance/upgrade detected — standing by',
    'maintenance.body': 'Signals: {signals}\nThe guard will not start, roll back or kill anything during the window. Window ends: {until}',
    supervised: 'A supervisor owns DSH — reporting only',
    'supervised.body': '{detail}\nLet the supervisor (or a person) restart it; the guard will not race it for the port.',
    flapping: 'Crash loop — guard paused',
    'flapping.body': '{count} failures within {windowMin} minutes; paused until {until}.',
    test: 'Restart guard test message',
    'test.body': 'Channel is working. Port {port}, current phase {phase}.',
    logTail: 'log tail',
    titlePrefix: 'restart-guard',
  },
}

/**
 * @param {string} locale
 * @param {string} key
 * @param {Record<string, string|number|boolean>} [vars]
 */
function t(locale, key, vars = {}) {
  const table = TEXT[locale] ?? TEXT.en
  const template = table[key] ?? TEXT.en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`))
}

/** @type {Record<string, Record<string, string>>} */
const HINTS = {
  zh: {
    'yaml-config': '检查 cordis.patch.yml 的 YAML 语法，或从 cordis.patch.yml.bak-* 恢复一份可用备份',
    'patch-incompatible': '该 patch 行与当前 DSH 版本不兼容：删除/改写对应行，或恢复升级前的备份',
    'wildcard-host': 'DSH 不接受 0.0.0.0，请绑定具体地址（如 --host 127.0.0.1）',
    'module-missing': '依赖缺失：运行 dsh plugin --profile <name> install 重建依赖树',
    'permission-disk-memory': '检查文件权限 / 磁盘剩余空间 / 内存上限',
    'port-in-use': '端口被其它进程占用：确认占用者后改端口或手动停掉它（守护不会强杀外来进程）',
    timeout: '启动超时：查看启动日志尾部；慢盘或依赖树过大可能导致超时',
    crash: '进程崩溃：按日志尾部修复后重试',
    unknown: '按日志尾部排查；修好后可在设置页点“立即重启”',
    stalled: '进程存活但无响应，已被守护重启；若反复出现请检查日志',
    'tree-incomplete': 'DSH 包树不完整（升级/换树中断）：先修复安装，再让守护启动',
    supervised: '当前由监督者托管：请使用监督者重启，守护不会抢占端口',
    maintenance: '维护/升级窗口内守护不动手；窗口结束后自动恢复监控',
  },
  en: {
    'yaml-config': 'Check the YAML in cordis.patch.yml or restore one of the cordis.patch.yml.bak-* backups',
    'patch-incompatible': 'That patch row does not fit this DSH version: edit/remove it, or restore the pre-upgrade backup',
    'wildcard-host': 'DSH rejects 0.0.0.0; bind a concrete address such as --host 127.0.0.1',
    'module-missing': 'Missing dependency: run dsh plugin --profile <name> install to rebuild the dependency tree',
    'permission-disk-memory': 'Check file permissions, free disk space and the memory limit',
    'port-in-use': 'Another process holds the port: identify it, change the port or stop it manually (the guard never kills foreign processes)',
    timeout: 'Boot timed out: read the boot log tail; a slow disk or a huge dependency tree can exceed the budget',
    crash: 'The process crashed: fix what the log tail shows, then retry',
    unknown: 'Investigate the log tail; once fixed use "Restart now" in the settings page',
    stalled: 'The process was alive but unresponsive and the guard restarted it; check the log if this repeats',
    'tree-incomplete': 'The DSH package tree is incomplete (interrupted upgrade/swap): repair the install before letting the guard start it',
    supervised: 'A supervisor owns DSH: restart it through the supervisor; the guard will not race for the port',
    maintenance: 'During a maintenance/upgrade window the guard stands by; monitoring resumes when the window ends',
  },
}

/**
 * @param {string} locale
 * @param {string} incident
 */
export function hintFor(locale, incident) {
  const table = HINTS[locale] ?? HINTS.en
  return table[incident] ?? table.unknown
}

/**
 * @param {string} locale
 * @returns {Record<string, string>}
 */
export function messageKeys(locale) {
  return { ...TEXT.en, ...(TEXT[locale] ?? {}) }
}

/**
 * @param {{
 *   locale: string,
 *   event: string,
 *   marks: Record<string, string|number|boolean>,
 *   config: import('./config.js').GuardConfig,
 *   logText?: string,
 * }} input
 * @returns {Report}
 */
export function buildReport({ locale, event, marks, config, logText = '' }) {
  const title = t(locale, event)
  const body = t(locale, `${event}.body`, marks)
  const lines = [body]
  if (config.notify.includeLogTail && config.notify.includeLogTailLines > 0 && logText) {
    const tail = tailForReport(logText, config.notify.includeLogTailLines)
    if (tail) lines.push(`\n${t(locale, 'logTail')}:\n\`\`\`\n${tail}\n\`\`\``)
  }
  const severity = /failed|flapping|down/.test(event) ? 'error' : event === 'maintenance' || event === 'supervised' ? 'info' : 'warning'
  const marksText = Object.entries(marks)
    .filter(([, value]) => value !== '' && value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  const markdown = [`## ${t(locale, 'titlePrefix')} · ${title}`, '', lines.join('\n'), '', '```', marksText, '```'].join('\n')
  return { title: `${t(locale, 'titlePrefix')} · ${title}`, summary: body, severity, marks, logTail: redactText(logText), markdown }
}

/**
 * @typedef {{ channel: string, ok: boolean, detail?: string }} Delivery
 */

/**
 * @param {{
 *   config: import('./config.js').GuardConfig,
 *   env: Record<string, string | undefined>,
 *   report: Report,
 *   locale: string,
 *   instanceDir: string,
 *   logger: { info: Function, warn: Function, error: Function },
 *   imSender?: ((input: { botId: string, targetId: string, text: string }) => Promise<{ ok: boolean, detail?: string }>) | null,
 * }} input
 * @returns {Promise<Delivery[]>}
 */
export async function deliver({ config, env, report, locale, instanceDir, logger, imSender = null }) {
  /** @type {Delivery[]} */
  const results = []
  const text = report.markdown

  const url = webhookUrl(config, env)
  if (config.notify.webhook.enabled && url) {
    const delivery = await sendWebhook({ config, env, url, report, text })
    results.push(delivery)
  }

  if (config.notify.command.enabled && config.notify.command.program) {
    results.push(await runCommand(config.notify.command.program, config.notify.command.args, text))
  }

  const im = imCredentials(config, env)
  if (config.notify.im.enabled && im.botId) {
    if (imSender) {
      try {
        const sent = await imSender({ botId: im.botId, targetId: im.targetId, text })
        results.push({ channel: 'im', ok: sent.ok, detail: sent.detail })
      } catch (error) {
        results.push({ channel: 'im', ok: false, detail: String(error) })
      }
    } else {
      appendOutbox(instanceDir, { channel: 'im', botId: im.botId, targetId: im.targetId, text, createdAt: Date.now(), event: report.title })
      results.push({ channel: 'im', ok: true, detail: 'queued in outbox (host not running)' })
    }
  }

  for (const result of results) {
    const level = result.ok ? 'info' : 'warn'
    logger[level]('notify', `${result.channel}: ${result.ok ? 'ok' : 'failed'}${result.detail ? ` (${result.detail})` : ''}`)
  }
  return results
}

/**
 * @param {{ config: import('./config.js').GuardConfig, env: Record<string, string|undefined>, url: string, report: Report, text: string }} input
 * @returns {Promise<Delivery>}
 */
async function sendWebhook({ config, env, url, report, text }) {
  const preset = config.notify.webhook.preset
  /** @type {{ body: string, headers: Record<string,string>, method: 'POST'|'GET' }} */
  let request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: report.summary, title: report.title, event: report.title }) }
  const json = (/** @type {any} */ payload) => JSON.stringify(payload)
  if (preset === 'feishu') request.body = json({ msg_type: 'text', content: { text } })
  else if (preset === 'wecom') request.body = json({ msgtype: 'text', text: { content: text } })
  else if (preset === 'dingtalk') request.body = json({ msgtype: 'text', text: { content: text } })
  else if (preset === 'slack') request.body = json({ text })
  else if (preset === 'discord') request.body = json({ content: text.slice(0, 1900) })
  else if (preset === 'telegram') {
    request.body = json({ chat_id: config.notify.webhook.chatId || undefined, text, disable_web_page_preview: true })
  } else if (preset === 'ntfy') {
    request.method = 'POST'
    request.headers = { 'content-type': 'text/plain; charset=utf-8', title: encodeURIComponent(report.title), priority: report.severity === 'error' ? 'high' : 'default', tags: 'warning' }
    request.body = text
  } else if (preset === 'healthchecks') {
    // healthchecks.io style ping: append /fail for a bad outcome.
    request = { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text }
  }

  const target =
    preset === 'healthchecks' ? `${url.replace(/\/+$/, '')}${report.severity === 'error' ? '/fail' : ''}` : url
  const headers = { ...request.headers, ...(config.notify.webhook.headers ?? {}) }
  if (config.notify.webhook.secret) headers['x-guard-secret'] = config.notify.webhook.secret
  void env
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    })
    const ok = response.ok
    return { channel: 'webhook', ok, detail: `HTTP ${response.status}` }
  } catch (error) {
    return { channel: 'webhook', ok: false, detail: String(/** @type {any} */ (error)?.message ?? error) }
  }
}

/**
 * @param {string} program
 * @param {string[]} args
 * @param {string} text
 * @returns {Promise<Delivery>}
 */
export function runCommand(program, args, text) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess | null} */
    let child = null
    /** @type {NodeJS.Timeout} */
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({ channel: 'command', ok: false, detail: 'timeout' })
    }, 15000)
    try {
      child = spawn(program, args ?? [], { stdio: ['pipe', 'ignore', 'pipe'], timeout: 15000, shell: false })
    } catch (error) {
      clearTimeout(timer)
      resolve({ channel: 'command', ok: false, detail: String(error) })
      return
    }
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ channel: 'command', ok: false, detail: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ channel: 'command', ok: code === 0, detail: `exit ${code}` })
    })
    try {
      child.stdin?.end(text)
    } catch {
      /* ignore */
    }
  })
}
