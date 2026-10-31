#!/usr/bin/env node
// @ts-check
/**
 * `dsh-restart-guard` CLI.
 *
 * The CLI never talks HTTP: the meta-token that guards the settings API is only
 * visible inside the authenticated SPA, and a shell process must not need it.
 * Instead the CLI reads the watcher's JSON state (mode 0600) and drops request
 * files that the watcher executes on its next tick.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dshHome, ensureDir, guardRoot, readJson, writeJsonAtomic } from './shared/paths.js'
import { clearControl, listIncidents, readOutbox, writeControl } from './shared/state.js'
import { loadConfig, resolveLocale } from './shared/config.js'
import { pidAlive } from './shared/probe.js'
import { buildDoctor } from './doctor.js'
import { redactConfig } from './shared/redact.js'
import { install, uninstall } from './install.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VERSION = readVersion()

const TEXT = {
  zh: {
    usage: `dsh-restart-guard ${VERSION}

用法：dsh-restart-guard <命令> [选项]

命令：
  status            显示守护状态（--json 输出原始 JSON）
  doctor            环境体检与完善建议
  logs              查看守护日志（-n 行数，-f 跟随）
  incidents         最近事件
  restart           请求重启 DSH（由守护执行）
  rollback          回滚最近一次 cordis.patch.yml 备份并重启
  start             请求启动 DSH
  simulate-crash    模拟崩溃（需 security.dangerousActions=true）
  pause [--minutes] 暂停自动修复
  resume            恢复
  notify-test       发送测试通知
  maintenance start|end [--minutes N] [--reason 文本]
  outbox            查看待补发通知
  install [--dry-run]    把本插件接入 profile（link: 本地目录）
  uninstall              从 profile 移除插件
  purge                  删除 $DSH_HOME/restart-guard 全部状态
  version

全局选项：
  --home <dir>       DSH_HOME（默认取环境变量或 ~/.dsh）
  --profile <name>   profile（默认 web，或 DSH_PROFILE）
  --port <n>         端口（默认自动挑选有存活实例的那一个）
`,
    noInstance: '没有找到守护实例。先启动 DSH（插件会在启动时拉起监控进程），或显式传 --profile/--port。',
    watcherDown: '监控进程没有在运行：无法投递动作请求。请重启 DSH 或查看日志。',
    unknown: '未知命令',
    notFound: '请求文件没有落地',
    phase: '状态',
    watcher: '监控进程',
    host: 'Host',
    port: '端口',
    profile: 'Profile',
    since: '开始于',
    updated: '更新于',
    lastError: '最近错误',
    outbox: '待补发',
    hints: '建议',
    none: '（无）',
    notRunning: '未运行',
    running: '运行中',
    restartSent: '已投递启动/重启请求，监控进程会在下一轮执行。',
    pauseSent: '已暂停自动修复',
    resumeSent: '已恢复自动修复',
    maintenanceSet: '维护窗口已设置',
    maintenanceCleared: '维护窗口已清除',
    installed: '已接入 profile，请重启 DSH 使其生效。',
  },
  en: {
    usage: `dsh-restart-guard ${VERSION}

Usage: dsh-restart-guard <command> [options]

Commands:
  status            show guard state (--json for raw JSON)
  doctor            environment checks and setup hints
  logs              tail the guard log (-n lines, -f follow)
  incidents         recent incidents
  restart           ask the watcher to restart DSH
  rollback          restore the latest cordis.patch.yml backup and restart
  start             ask the watcher to start DSH
  simulate-crash    crash drill (needs security.dangerousActions=true)
  pause [--minutes] pause automatic repair
  resume            resume
  notify-test       send a test notification
  maintenance start|end [--minutes N] [--reason text]
  outbox            list queued notifications
  install [--dry-run]    install this plugin into a profile (link:)
  uninstall              remove the plugin from a profile
  ai-test                ask the configured AI for a diagnosis (no action taken)
  purge                  delete all $DSH_HOME/restart-guard state
  version

Global options:
  --home <dir>      DSH_HOME (default: env or ~/.dsh)
  --profile <name>  profile (default: web, or DSH_PROFILE)
  --port <n>        port (default: the instance with a live host)
`,
    noInstance: 'No guard instance found. Start DSH (the plugin starts the watcher on boot) or pass --profile/--port.',
    watcherDown: 'The watcher is not running: cannot deliver actions. Restart DSH or check the log.',
    unknown: 'Unknown command',
    notFound: 'The request file was not written',
    phase: 'Phase',
    watcher: 'Watcher',
    host: 'Host',
    port: 'Port',
    profile: 'Profile',
    since: 'since',
    updated: 'updated',
    lastError: 'Last error',
    outbox: 'Outbox',
    hints: 'Hints',
    none: '(none)',
    notRunning: 'not running',
    running: 'running',
    restartSent: 'Request delivered; the watcher will act on its next tick.',
    pauseSent: 'Automatic repair paused',
    resumeSent: 'Automatic repair resumed',
    maintenanceSet: 'Maintenance window set',
    maintenanceCleared: 'Maintenance window cleared',
    installed: 'Installed into the profile; restart DSH to activate it.',
  },
}

const argv = process.argv.slice(2)
const options = parseArgs(argv)
/** @type {Record<string, string | undefined>} */
const env = { ...process.env, DSH_HOME: options.home || process.env.DSH_HOME || dshHome(process.env) }
const home = dshHome(env)
const locale = resolveLocale(loadConfig({ env }).config, env)
const t = /** @type {Record<string, any>} */ (TEXT[locale] || TEXT.en)

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

async function main() {
  const command = options.positionals[0] || 'status'
  if (command === 'version' || command === '--version') {
    console.log(VERSION)
    return
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(t.usage)
    return
  }
  if (command === 'install') return runInstall('install')
  if (command === 'uninstall') return runInstall('uninstall')
  if (command === 'purge') return runPurge()

  const instance = resolveInstance()
  if (!instance) {
    console.error(t.noInstance)
    process.exit(2)
  }

  switch (command) {
    case 'status':
      return status(instance)
    case 'doctor':
      return doctor(instance)
    case 'logs':
    case 'log':
      return logs(instance)
    case 'incidents':
      return incidents(instance)
    case 'outbox':
      return outbox(instance)
    case 'pause':
      return pause(instance)
    case 'resume':
      return resume(instance)
    case 'maintenance':
      return maintenance(instance)
    case 'restart':
      return request(instance, 'restart')
    case 'rollback':
      return request(instance, 'rollback')
    case 'start':
      return request(instance, 'start')
    case 'simulate-crash':
      return request(instance, 'simulate-crash')
    case 'notify-test':
    case 'test-notify':
      return request(instance, 'test-notify')
    case 'ai-test':
      return request(instance, 'ai-test')
    case 'reload':
      return request(instance, 'reload')
    default:
      console.error(`${t.unknown}: ${command}`)
      console.log(t.usage)
      process.exit(2)
  }
}

/** @returns {any} */
/** @param {{ dir: string, profile: string, port: number }} instance */
function status(instance) {
  const state = readJson(path.join(instance.dir, 'state.json'), null)
  const watcher = readJson(path.join(instance.dir, 'watcher.json'), null)
  const config = loadConfig({ env }).config
  if (options.json) {
    console.log(JSON.stringify({ instance: instance.dir, state, watcher, config: redactConfig(config) }, null, 2))
    return
  }
  const alive = Boolean(watcher && pidAlive(watcher.pid) && Date.now() - Number(watcher.heartbeatAt || 0) < 20_000)
  const lines = [
    `${t.phase}:      ${state?.phase ?? 'unknown'}`,
    `${t.watcher}:    ${alive ? `${t.running} (pid ${watcher.pid})` : t.notRunning}`,
    `${t.host}:       pid ${state?.host?.pid ?? '?'}${state?.host?.pid ? `, ${t.since} ${formatTime(state?.host?.startMs)}` : ''}`,
    `${t.port}:       ${instance.port}`,
    `${t.profile}:    ${instance.profile}`,
    `${t.updated}:    ${formatTime(state?.updatedAt)}`,
    `${t.outbox}:     ${readOutbox(instance.dir).length}`,
  ]
  if (state?.lastError) lines.push(`${t.lastError}: ${state.lastError}`)
  if (state?.incident) lines.push(`incident:   ${state.incident.incident} (${state.incident.detail || ''})`)
  console.log(lines.join('\n'))
  console.log(`dir:        ${instance.dir}`)
}

/** @returns {any} */
/** @param {{ dir: string, profile: string, port: number }} instance */
function doctor(instance) {
  const config = loadConfig({ env }).config
  const watcher = readJson(path.join(instance.dir, 'watcher.json'), null)
  const result = buildDoctor({
    env,
    port: instance.port,
    profile: instance.profile,
    instanceDir: instance.dir,
    config,
    watcher: watcher
      ? { alive: Boolean(pidAlive(watcher.pid)), pid: watcher.pid, heartbeatAt: Number(watcher.heartbeatAt || 0), version: String(watcher.version || '') }
      : null,
    imAvailable: false,
    probe: null,
  })
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (const check of result.checks) {
    const mark = check.level === 'ok' ? 'ok ' : check.level === 'warn' ? 'warn' : 'FAIL'
    console.log(`${mark.padEnd(4)} ${check.id.padEnd(16)} ${check.detail}`)
  }
  if (result.hints.length > 0) {
    console.log(`\n${t.hints}:`)
    for (const hint of result.hints) console.log(`- ${locale === 'zh' ? hint.zh : hint.en}`)
  }
}

/** @returns {any} */
/** @param {{ dir: string, profile: string, port: number }} instance */
function logs(instance) {
  const file = path.join(instance.dir, 'restart-guard.log')
  const lines = Number(options.lines || 60)
  if (!fs.existsSync(file)) {
    console.log(`${t.none}: ${file}`)
    return
  }
  const tail = tailLines(file, lines)
  process.stdout.write(tail)
  if (!options.follow) return
  let position = fs.statSync(file).size
  fs.watchFile(file, { interval: 500 }, () => {
    try {
      const size = fs.statSync(file).size
      if (size <= position) return
      const handle = fs.openSync(file, 'r')
      const buffer = Buffer.alloc(size - position)
      fs.readSync(handle, buffer, 0, buffer.length, position)
      fs.closeSync(handle)
      position = size
      process.stdout.write(buffer.toString('utf8'))
    } catch {
      /* the file may rotate */
    }
  })
}

/** @returns {any} */
/** @param {{ dir: string, profile: string, port: number }} instance */
function incidents(instance) {
  const list = listIncidents(instance.dir, Number(options.lines || 20))
  if (options.json) {
    console.log(JSON.stringify(list, null, 2))
    return
  }
  if (list.length === 0) {
    console.log(t.none)
    return
  }
  for (const incident of list) {
    const resolved = incident.resolvedAt ? `resolved ${formatTime(incident.resolvedAt)}` : 'open'
    console.log(`${formatTime(incident.startedAt)}  ${incident.incident}  ${resolved}`)
    if (incident.detail) console.log(`    ${incident.detail}`)
  }
}

/** @returns {any} */
/** @param {{ dir: string, profile: string, port: number }} instance */
function outbox(instance) {
  const entries = readOutbox(instance.dir)
  if (options.json) {
    console.log(JSON.stringify(entries, null, 2))
    return
  }
  if (entries.length === 0) {
    console.log(t.none)
    return
  }
  for (const item of entries) console.log(`${formatTime(item.entry?.createdAt)}  ${item.entry?.channel}  ${item.name}`)
}

/** @param {any} instance @returns {any} */
/** @param {{ dir: string, profile: string, port: number }} instance */
function pause(instance) {
  const minutes = Math.max(1, Math.min(24 * 60, Number(options.minutes || 15)))
  writeControl(instance.dir, 'pause', { until: Date.now() + minutes * 60_000, reason: String(options.reason || 'cli') })
  console.log(`${t.pauseSent} (${minutes}m)`)
}

/** @param {any} instance @returns {any} */
/** @param {{ dir: string, profile: string, port: number }} instance */
function resume(instance) {
  clearControl(instance.dir, 'pause')
  console.log(t.resumeSent)
}

/** @param {any} instance @returns {any} */
/** @param {{ dir: string, profile: string, port: number }} instance */
function maintenance(instance) {
  const action = options.positionals[1] || 'start'
  if (action === 'end' || action === 'stop') {
    clearControl(instance.dir, 'maintenance')
    console.log(t.maintenanceCleared)
    return
  }
  const minutes = Math.max(1, Math.min(24 * 60, Number(options.minutes || 15)))
  writeControl(instance.dir, 'maintenance', { until: Date.now() + minutes * 60_000, reason: String(options.reason || 'cli') })
  console.log(`${t.maintenanceSet} (${minutes}m)`)
}

/** @param {{ dir: string, profile: string, port: number }} instance @param {string} action */
function request(instance, action) {
  const watcher = readJson(path.join(instance.dir, 'watcher.json'), null)
  if (!watcher || !pidAlive(watcher.pid)) {
    console.error(t.watcherDown)
    process.exit(3)
  }
  ensureDir(path.join(instance.dir, 'control', 'requests'), 0o700)
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  const file = path.join(instance.dir, 'control', 'requests', name)
  writeJsonAtomic(file, { action, requestedAt: Date.now(), source: 'cli', requesterPid: process.pid, reason: options.reason || '' })
  if (!fs.existsSync(file)) {
    console.error(t.notFound)
    process.exit(3)
  }
  console.log(`${t.restartSent} (${action})`)
}

/** @param {'install'|'uninstall'} mode */
function runInstall(mode) {
  const result =
    mode === 'install'
      ? install({ env, profile: options.profile || env.DSH_PROFILE || 'web', root, dryRun: Boolean(options.dryRun) })
      : uninstall({ env, profile: options.profile || env.DSH_PROFILE || 'web' })
  if (result.hints && result.hints.length > 0) {
    for (const hint of result.hints) console.log(`- ${hint}`)
  }
  if (mode === 'install' && options.dryRun) {
    console.log('Dry run: profile unchanged, pnpm not run.')
  } else {
    console.log(mode === 'install' ? t.installed : 'Removed from the profile; restart DSH to apply.')
  }
}

function runPurge() {
  const target = guardRoot(env)
  if (!fs.existsSync(target)) {
    console.log(`${t.none}: ${target}`)
    return
  }
  fs.rmSync(target, { recursive: true, force: true })
  console.log(`removed ${target}`)
}

function resolveInstance() {
  if (options.instance) {
    const dir = String(options.instance)
    const pid = readJson(path.join(dir, 'pid.json'), null)
    const config = readJson(path.join(dir, 'config.json'), null)
    void config
    return { dir, profile: pid?.profile ?? 'unknown', port: Number(pid?.port || 0) }
  }
  const rootDir = path.join(guardRoot(env), 'instances')
  if (!fs.existsSync(rootDir)) return null
  const dirs = fs
    .readdirSync(rootDir)
    .map((name) => path.join(rootDir, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'state.json')) || fs.existsSync(path.join(dir, 'pid.json')))
  if (dirs.length === 0) return null
  if (options.profile && options.port) {
    const exact = dirs.find((dir) => {
      const pid = readJson(path.join(dir, 'pid.json'), null)
      return pid && pid.profile === options.profile && Number(pid.port) === Number(options.port)
    })
    if (exact) return describe(exact)
  }
  /** @type {Array<{ dir: string, pid: any }>} */
  const entries = dirs.map((dir) => ({ dir, pid: readJson(path.join(dir, 'pid.json'), null) }))
  const alive = entries.filter((entry) => entry.pid && pidAlive(Number(entry.pid.pid)))
  if (alive.length > 0) return describe(alive.sort((a, b) => Number(b.pid.port) - Number(a.pid.port))[0].dir)
  if (options.profile) {
    const match = dirs.find((dir) => dir.includes(`${options.profile}-`))
    if (match) return describe(match)
  }
  return describe(dirs.sort((a, b) => mtime(b) - mtime(a))[0])
}

/** @param {string} dir */
/** @param {string} dir */
function describe(dir) {
  const pid = readJson(path.join(dir, 'pid.json'), null)
  return { dir, profile: pid?.profile ?? 'unknown', port: Number(pid?.port || 0) }
}

/** @param {string} dir */
function mtime(dir) {
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/** @param {string} file @param {number} count */
function tailLines(file, count) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  return `${lines.slice(Math.max(0, lines.length - count - 1)).join('\n')}\n`
}

/** @param {number | undefined} ms */
function formatTime(ms) {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

/** @param {string[]} list */
function parseArgs(list) {
  /** @type {{ positionals: string[], home?: string, profile?: string, port?: number, instance?: string, json?: boolean, follow?: boolean, minutes?: number, reason?: string, lines?: number, dryRun?: boolean }} */
  const result = { positionals: [] }
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    switch (item) {
      case '--home':
        result.home = list[++index]
        break
      case '--profile':
        result.profile = list[++index]
        break
      case '--port':
        result.port = Number(list[++index])
        break
      case '--instance':
        result.instance = list[++index]
        break
      case '--json':
        result.json = true
        break
      case '-f':
      case '--follow':
        result.follow = true
        break
      case '-n':
      case '--lines':
        result.lines = Number(list[++index])
        break
      case '--minutes':
        result.minutes = Number(list[++index])
        break
      case '--reason':
        result.reason = list[++index]
        break
      case '--dry-run':
        result.dryRun = true
        break
      default:
        result.positionals.push(item)
    }
  }
  return result
}

function readVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

void spawnSync
