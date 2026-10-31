// @ts-check
/**
 * Environment self-check.
 *
 * The settings page (and `guard doctor`) show this list right after install so
 * the operator can finish the setup instead of discovering the gaps during an
 * outage. Every check is read-only and must stay cheap enough to run on page
 * load.
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson, statSafe } from './shared/paths.js'
import { pidAlive } from './shared/probe.js'
import { detectMaintenance, treeSnapshot } from './shared/maintenance.js'
import { detectSupervisor } from './shared/supervision.js'
import { webhookUrl, imCredentials } from './shared/config.js'
import { aiSettings } from './shared/ai.js'

/** @typedef {{ id: string, ok: boolean, level: 'ok'|'warn'|'error', detail: string }} Check */
/** @typedef {{ id: string, level: 'warn'|'error', zh: string, en: string }} Hint */
/** @type {Record<string, { level: 'warn'|'error', zh: string, en: string }>} */

const HINTS = {
  'webhook-missing': {
    level: 'warn',
    zh: '还没有配置通知渠道：现在只会写本地日志（$DSH_HOME/restart-guard/instances/<profile>-<port>/restart-guard.log）。在“通知”里填 Webhook 或 IM 的 botId/targetId。',
    en: 'No notification channel yet: only the local log is written. Configure a webhook or the IM botId/targetId in the Notification section.',
  },
  'im-target-missing': {
    level: 'warn',
    zh: '已选 IM Bot 但没填 targetId：去 dsh-im 设置里复制一个，或用设置页的“扫描 dsh-im”下拉选择。',
    en: 'A bot is selected but no targetId is set: copy one from dsh-im, or use the “Scan dsh-im” picker on the settings page.',
  },
  'im-missing': {
    level: 'warn',
    zh: '没检测到可用的 dsh-im 注入服务（或未启用 IM 通道）。IM 通知需要 dsh-im 插件处于启用状态。',
    en: 'The dsh-im injection service is not available (or the IM channel is disabled). IM delivery requires the dsh-im plugin.',
  },
  'boot-log-unknown': {
    level: 'warn',
    zh: '还没捕获到启动日志位置：守护重启后无法从日志里确认新的访问令牌。请确认 DSH 的 stdout 被重定向到文件（nohup/重定向），或在“高级”里指定启动日志路径。',
    en: 'The boot log location has not been captured: after a restart the guard cannot confirm the fresh access token. Make sure DSH stdout is redirected to a file, or set the boot log path under Advanced.',
  },
  'supervisor-detected': {
    level: 'warn',
    zh: '检测到进程监督者（systemd/pm2 等）。守护只报告不重启，避免与监督者抢占端口。',
    en: 'A supervisor (systemd/pm2, …) was detected. The guard only reports; it will not race the supervisor for the port.',
  },
  'ai-no-key': {
    level: 'warn',
    zh: 'AI 修复已开启但找不到 API Key：请在环境里设置对应的密钥变量（默认 DEEPSEEK_API_KEY），或在设置页把密钥变量名改成实际使用的名字。',
    en: 'AI repair is enabled but no API key was found. Export the configured key variable (default DEEPSEEK_API_KEY) or change the variable name in the settings page.',
  },
  'dangerous-actions-off': {
    level: 'warn',
    zh: '“危险操作”（模拟崩溃演练）默认关闭。要演练请先在设置里打开 security.dangerousActions。',
    en: 'Dangerous actions (crash drill) are off by default. Enable security.dangerousActions to rehearse a failure.',
  },
  'patch-no-backup': {
    level: 'warn',
    zh: '没有找到 cordis.patch.yml 的备份：YAML 损坏时无法自动回滚。建议先备份一次。',
    en: 'No cordis.patch.yml backup found: automatic rollback is impossible if the YAML breaks. Make a backup.',
  },
  'maintenance-active': {
    level: 'warn',
    zh: '当前处于维护/升级窗口：守护不会启动、回滚或终止任何进程。',
    en: 'A maintenance/upgrade window is active: the guard will not start, roll back or kill anything.',
  },
  'tree-incomplete': {
    level: 'error',
    zh: 'DSH 包树看起来不完整（升级/换树中断）：请先修复安装，守护不会启动服务。',
    en: 'The DSH package tree looks incomplete (interrupted upgrade/swap): repair the install; the guard will not start a server.',
  },
  'patch-yaml-suspicious': {
    level: 'error',
    zh: 'cordis.patch.yml 看起来像坏掉的 YAML（出现制表符或不是数组），下次启动会失败。',
    en: 'cordis.patch.yml looks like broken YAML (tabs, or not an array). The next boot will fail.',
  },
  'no-launch-spec': {
    level: 'warn',
    zh: '还没有捕获到启动参数：守护无法自行启动 DSH。保持 DSH 运行几秒后刷新即可。',
    en: 'No launch spec captured yet: the guard cannot start DSH by itself. Keep DSH running for a few seconds and refresh.',
  },
}

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   port: number,
 *   profile: string,
 *   instanceDir: string,
 *   config: import('./shared/config.js').GuardConfig,
 *   watcher: { alive: boolean, pid: number, heartbeatAt: number, version: string } | null,
 *   imAvailable: boolean,
 *   imInfo?: { available: boolean, reason: string, bots: any[], targets: Record<string, any[]> } | null,
 *   probe: { ok: boolean, kind: string, status: number } | null,
 * }} input
 */
export function buildDoctor({ env, port, profile, instanceDir, config, watcher, imAvailable, imInfo = null, probe }) {
  /** @type {Check[]} */
  const checks = []
  /** @type {Hint[]} */
  const hints = []
  const home = env.DSH_HOME || path.join(env.HOME || '', '.dsh')
  const profileDir = path.join(home, 'profiles', profile)
  const patchPath = path.join(profileDir, 'cordis.patch.yml')

  checks.push({ id: 'node', ok: true, level: 'ok', detail: `${process.version} on ${process.platform}` })

  const binPath = whichDsh(env)
  checks.push({ id: 'dsh-bin', ok: Boolean(binPath), level: binPath ? 'ok' : 'error', detail: binPath || 'dsh not found on PATH' })
  const tree = treeSnapshot(profileDir, binPath || '/usr/local/bin/dsh')
  checks.push({
    id: 'tree',
    ok: tree.exists && Boolean(tree.version),
    level: tree.exists ? 'ok' : 'error',
    detail: tree.exists ? `${tree.pkgRoot}@${tree.version}` : 'package tree not readable',
  })
  if (!tree.exists) hints.push({ id: 'tree-incomplete', ...HINTS['tree-incomplete'] })

  const patchStat = statSafe(patchPath)
  checks.push({ id: 'patch', ok: Boolean(patchStat?.isFile()), level: patchStat ? 'ok' : 'warn', detail: patchPath })
  if (patchStat?.isFile()) {
    const suspicious = patchLooksBroken(patchPath)
    checks.push({
      id: 'patch-yaml',
      ok: !suspicious,
      level: suspicious ? 'error' : 'ok',
      detail: suspicious || 'looks like a YAML array',
    })
    if (suspicious) hints.push({ id: 'patch-yaml-suspicious', ...HINTS['patch-yaml-suspicious'] })
    let backups = 0
    try {
      backups = fs.readdirSync(profileDir).filter((name) => name.startsWith('cordis.patch.yml.bak-')).length
    } catch {
      backups = 0
    }
    checks.push({ id: 'patch-backups', ok: backups > 0, level: backups > 0 ? 'ok' : 'warn', detail: `${backups} backup(s)` })
    if (backups === 0) hints.push({ id: 'patch-no-backup', ...HINTS['patch-no-backup'] })
  }

  checks.push({
    id: 'port',
    ok: Boolean(probe?.ok),
    level: probe?.ok ? 'ok' : 'warn',
    detail: probe ? `127.0.0.1:${port} -> ${probe.status || 'down'} (${probe.kind})` : 'not probed yet',
  })

  const supervisor = detectSupervisor({ env, ppid: process.ppid })
  checks.push({
    id: 'supervisor',
    ok: supervisor.kind === 'none' || supervisor.mayAct,
    level: supervisor.mayAct ? 'ok' : 'warn',
    detail: `${supervisor.kind}: ${supervisor.detail}`,
  })
  if (!supervisor.mayAct) hints.push({ id: 'supervisor-detected', ...HINTS['supervisor-detected'] })

  const watcherOk = Boolean(watcher?.alive)
  checks.push({
    id: 'watcher',
    ok: watcherOk,
    level: watcherOk ? 'ok' : 'error',
    detail: watcher?.alive ? `pid ${watcher.pid}, heartbeat ${Math.round((Date.now() - watcher.heartbeatAt) / 1000)}s ago` : 'watcher is not running',
  })

  const launchPath = path.join(instanceDir, 'launch.json')
  const launch = readJson(launchPath, null)
  const bootLogKnown = Boolean(launch?.stdoutPath || config.logs.bootLogPath)
  checks.push({
    id: 'boot-log',
    ok: bootLogKnown,
    level: bootLogKnown ? 'ok' : 'warn',
    detail: config.logs.bootLogPath || launch?.stdoutPath || 'not known (stdout is a pipe or unrecorded)',
  })
  if (!launch) hints.push({ id: 'no-launch-spec', ...HINTS['no-launch-spec'] })
  else if (!bootLogKnown) hints.push({ id: 'boot-log-unknown', ...HINTS['boot-log-unknown'] })

  const hookUrl = webhookUrl(config, env)
  checks.push({
    id: 'webhook',
    ok: Boolean(hookUrl) && config.notify.webhook.enabled,
    level: hookUrl && config.notify.webhook.enabled ? 'ok' : 'warn',
    detail: hookUrl ? (config.notify.webhook.enabled ? 'configured' : 'URL present but the channel is disabled') : 'not configured',
  })

  const im = imCredentials(config, env)
  checks.push({
    id: 'im',
    ok: Boolean(imAvailable && im.botId && im.targetId),
    level: imAvailable && im.botId && im.targetId ? 'ok' : 'warn',
    detail: imAvailable ? `${im.botId && im.targetId ? 'configured' : 'dsh-im available, botId/targetId missing'}` : 'dsh-im service not available',
  })
  if (!hookUrl && !(im.botId && im.targetId)) hints.push({ id: 'webhook-missing', ...HINTS['webhook-missing'] })
  if (!imAvailable) hints.push({ id: 'im-missing', ...HINTS['im-missing'] })
  if (imAvailable && im.botId && !im.targetId) hints.push({ id: 'im-target-missing', ...HINTS['im-target-missing'] })

  const ai = aiSettings(config, env)
  checks.push({
    id: 'ai',
    ok: !ai.enabled || Boolean(ai.apiKey),
    level: !ai.enabled ? 'ok' : ai.apiKey ? 'ok' : 'warn',
    detail: ai.enabled ? `${ai.preset} ${ai.model || '(model unset)'} via ${ai.keyEnv}${ai.apiKey ? '' : ' (no key in env)'}` : 'disabled (rule-based repairs only)',
  })
  if (ai.enabled && !ai.apiKey) hints.push({ id: 'ai-no-key', ...HINTS['ai-no-key'] })

  const maintenance = detectMaintenance({
    now: Date.now(),
    config,
    env,
    instance: { dir: instanceDir, hostPid: 0, pkgRoot: '', profileDir, binPath: binPath || '/usr/local/bin/dsh', baseline: readJson(path.join(instanceDir, 'baseline.json'), null) },
    explicit: readJson(path.join(instanceDir, 'control', 'maintenance.json'), null),
  })
  checks.push({
    id: 'maintenance',
    ok: !maintenance.active,
    level: maintenance.active ? 'warn' : 'ok',
    detail: maintenance.active ? `${maintenance.signal}: ${maintenance.signals.join('; ').slice(0, 300)}` : 'none',
  })
  if (maintenance.active) hints.push({ id: 'maintenance-active', ...HINTS['maintenance-active'] })
  if (!config.security.dangerousActions) hints.push({ id: 'dangerous-actions-off', ...HINTS['dangerous-actions-off'] })

  checks.push({
    id: 'config',
    ok: true,
    level: 'ok',
    detail: path.join(home, 'restart-guard', 'config.json'),
  })

  return {
    checks,
    hints,
    summary: {
      ok: checks.every((check) => check.level !== 'error'),
      ready: watcherOk && !maintenance.active,
      port,
      profile,
      instanceDir,
      nodeVersion: process.version,
      dshVersion: tree.version,
      supervisor: supervisor.kind,
      maintenance: maintenance.active ? maintenance.signal : 'none',
    },
  }
}

/** @param {Record<string, string | undefined>} env */
function whichDsh(env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'dsh')
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* ignore */
    }
  }
  return ''
}

/**
 * @param {string} patchPath
 * @returns {string} empty when the file looks valid, a reason otherwise
 */
export function patchLooksBroken(patchPath) {
  try {
    const text = fs.readFileSync(patchPath, 'utf8')
    // Comments and blank lines are allowed above the array; only the first
    // meaningful line decides whether this is a YAML list.
    const meaningful = text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    if (meaningful.length === 0) return ''
    if (meaningful.some((line) => /^\s*\t/.test(line))) return 'contains a tab character'
    const first = meaningful[0].trim()
    if (!first.startsWith('-') && !first.startsWith('[')) return 'does not start with a YAML list'
    return ''
  } catch (error) {
    return String(error)
  }
}

/** @param {string} dir */
export function instanceFresh(dir) {
  return Boolean(statSafe(dir))
}

/** @param {number} pid */
export { pidAlive }
