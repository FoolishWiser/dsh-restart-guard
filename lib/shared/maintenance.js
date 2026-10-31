// @ts-check
/**
 * Maintenance / upgrade recognition.
 *
 * The single most important false positive this plugin can produce is
 * "intervening" while the operator is upgrading DSH: the old process is
 * killed on purpose, the new tree is being swapped, and the guard would spawn a
 * second server or roll back files mid-swap. Every signal here exists to make
 * the guard stand down and just watch.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mtimeMs, readJson, statSafe } from './paths.js'
import { listProcesses } from './probe.js'

/** @typedef {'explicit'|'tree-change'|'sibling-tree'|'package-manager'|'upgrade-dir'|'drill'|'none'} MaintenanceSignal */
/** @typedef {'running'|'done'|'failed'|'unknown'} MaintenanceTerminal */

/**
 * @typedef {{
 *   active: boolean,
 *   signal: MaintenanceSignal,
 *   signals: string[],
 *   until: number | null,
 *   terminal: MaintenanceTerminal,
 *   treeIntact: boolean,
 *   treeVersion: string,
 *   upgradeDir: string,
 *   restarters: { pid: number, cmdline: string }[],
 * }} MaintenanceStatus
 */

/** @param {string} value */
function safeRealpath(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return value
  }
}

/**
 * Package roots whose sibling trees look like an in-flight swap
 * (`dsh.new`, `dsh.prev-<ts>`, `dsh.failed-<ts>`).
 * @param {string} pkgRoot
 * @returns {string[]}
 */
export function siblingTrees(pkgRoot) {
  const parent = path.dirname(pkgRoot)
  const base = path.basename(pkgRoot)
  try {
    return fs
      .readdirSync(parent)
      .filter((name) => name !== base && new RegExp(`^${escapeRegExp(base)}\\.(new|next|prev|failed|old)`, 'i').test(name))
      .map((name) => path.join(parent, name))
  } catch {
    return []
  }
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {string} profileDir
 * @param {string} [binPath]
 */
export function treeSnapshot(profileDir, binPath = '/usr/local/bin/dsh') {
  /** @type {{ pkgRoot: string, version: string, ino: number, mtimeMs: number, binTarget: string, binIno: number, exists: boolean }} */
  const out = { pkgRoot: '', version: '', ino: 0, mtimeMs: 0, binTarget: '', binIno: 0, exists: false }
  let pkgRoot = ''
  try {
    const link = safeRealpath(binPath)
    // <pkgRoot>/lib/bin.js (the dsh entry) → <pkgRoot>
    if (link.endsWith('/lib/bin.js')) pkgRoot = path.dirname(path.dirname(link))
  } catch {
    /* ignore */
  }
  if (!pkgRoot) return out
  out.pkgRoot = pkgRoot
  const pkg = readJson(path.join(pkgRoot, 'package.json'), null)
  out.exists = Boolean(pkg)
  if (pkg) {
    out.version = typeof pkg.version === 'string' ? pkg.version : ''
    const dirStat = statSafe(pkgRoot)
    out.ino = dirStat?.ino ?? 0
    out.mtimeMs = Math.floor(mtimeMs(pkgRoot))
  }
  const binStat = statSafe(binPath)
  out.binIno = binStat?.ino ?? 0
  try {
    out.binTarget = fs.readlinkSync(binPath)
  } catch {
    out.binTarget = binPath
  }
  void profileDir
  return out
}

/** @param {string} root */
export function latestUpgradeDir(root) {
  /** @type {string} */
  let best = ''
  let bestTime = 0
  try {
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name)
      const stat = statSafe(full)
      if (!stat?.isDirectory()) continue
      const time = stat.mtimeMs
      if (time > bestTime) {
        bestTime = time
        best = full
      }
    }
  } catch {
    return ''
  }
  return best
}

/**
 * Terminal state of an upgrade artifact directory.
 * @param {string} dir
 * @returns {MaintenanceTerminal}
 */
export function upgradeTerminal(dir) {
  if (!dir || !fs.existsSync(dir)) return 'unknown'
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^result.*\.json$/i.test(name)) continue
      const value = readJson(path.join(dir, name), null)
      if (value && typeof value === 'object') {
        if (value.ok === true) return 'done'
        if (value.ok === false) return 'failed'
      }
    }
  } catch {
    /* ignore */
  }
  const statusPath = path.join(dir, 'status.jsonl')
  if (fs.existsSync(statusPath)) {
    try {
      const lines = fs.readFileSync(statusPath, 'utf8').trim().split('\n').filter(Boolean)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = safeJson(lines[index])
        const phase = String(parsed?.phase ?? parsed?.stage ?? '')
        if (parsed?.ok === false) return 'failed'
        if (/^(rolledback|failed|error)$/i.test(phase)) return 'failed'
        if (parsed?.ok === true) return 'done'
        if (/^(done|complete)$/i.test(phase)) return 'done'
      }
    } catch {
      /* ignore */
    }
  }
  if (fs.existsSync(path.join(dir, 'SUMMARY.md'))) {
    try {
      const text = fs.readFileSync(path.join(dir, 'SUMMARY.md'), 'utf8')
      if (/rolled back|rollback|失败/i.test(text)) return 'failed'
      if (/complete|success|完成/i.test(text)) return 'done'
    } catch {
      /* ignore */
    }
  }
  return 'running'
}

/** @param {string} text */
function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * @param {{ command: string[] }} process
 * @param {readonly string[]} patterns
 */
function matchesAny(process, patterns) {
  const line = process.command.join(' ')
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(line)
    } catch {
      return false
    }
  })
}

/**
 * Processes that look like they are about to restart DSH themselves
 * (upgrade cutover, the package-manager restart helper, a `dsh web` wrapper).
 * Used both for the package-manager maintenance signal and for the restart
 * arbitration grace.
 * @param {{ patterns: readonly string[], excludePid: number, maxAgeMs?: number }} options
 */
export function detectRestarters({ patterns, excludePid, maxAgeMs = 120000 }) {
  if (patterns.length === 0) return []
  const now = Date.now()
  /** @type {{ pid: number, cmdline: string }[]} */
  const out = []
  for (const process of listProcesses()) {
    if (process.pid === excludePid) continue
    if (maxAgeMs > 0 && process.startMs > 0 && now - process.startMs > maxAgeMs) continue
    if (!matchesAny({ command: process.cmdline }, patterns)) continue
    out.push({ pid: process.pid, cmdline: process.cmdline.join(' ') })
  }
  return out
}

/**
 * @param {{
 *   now: number,
 *   config: import('./config.js').GuardConfig,
 *   env: Record<string, string | undefined>,
 *   instance: { dir: string, hostPid: number, pkgRoot: string, profileDir: string, binPath: string, baseline: any },
 *   explicit: { until?: number, reason?: string } | null,
 * }} input
 * @returns {MaintenanceStatus}
 */
export function detectMaintenance({ now, config, env, instance, explicit }) {
  const maintenance = config.maintenance
  const signals = []
  /** @type {MaintenanceSignal} */
  let signal = 'none'
  /** @type {number | null} */
  let until = null
  /** @type {MaintenanceTerminal} */
  let terminal = 'unknown'
  /** @type {string} */
  let upgradeDir = ''

  const snapshot = treeSnapshot(instance.profileDir, instance.binPath)
  const treeIntact = Boolean(snapshot.exists && snapshot.version && snapshot.pkgRoot)
  const baseline = instance.baseline

  if (explicit && typeof explicit.until === 'number' && now < explicit.until) {
    signals.push(`explicit: ${explicit.reason || 'until ' + new Date(explicit.until).toISOString()}`)
    signal = 'explicit'
    until = explicit.until
    terminal = 'running'
  }

  if (config.security.dangerousActions && explicit?.reason === 'drill') signal = 'drill'

  if (baseline && baseline.ino && snapshot.ino && baseline.ino !== snapshot.ino) {
    signals.push('tree-inode-changed')
    if (signal === 'none') signal = 'tree-change'
  }
  if (baseline && baseline.version && snapshot.version && baseline.version !== snapshot.version) {
    signals.push(`tree-version ${baseline.version} -> ${snapshot.version}`)
    if (signal === 'none') signal = 'tree-change'
  }

  if (maintenance.autoDetect && treeIntact) {
    // A `dsh.prev-<ts>` left behind by a *finished* upgrade is normal: it must
    // not keep the guard in maintenance forever. Only a fresh sibling tree, one
    // touched inside the lookback window, counts as an in-flight swap.
    const siblings = siblingTrees(snapshot.pkgRoot).filter((dir) => now - mtimeMs(dir) <= maintenance.lookbackMs)
    if (siblings.length > 0) {
      signals.push(`sibling-trees: ${siblings.map((dir) => path.basename(dir)).join(',')}`)
      if (signal === 'none') signal = 'sibling-tree'
    }
  }

  const upgradeRoots = maintenance.upgradeRoots.map((root) =>
    root.startsWith('$DSH_HOME') ? root.replace('$DSH_HOME', env.DSH_HOME || path.join(env.HOME || '', '.dsh')) : root,
  )
  for (const root of upgradeRoots) {
    const dir = latestUpgradeDir(root)
    if (!dir) continue
    if (now - mtimeMs(dir) > maintenance.lookbackMs) continue
    const foundTerminal = upgradeTerminal(dir)
    signals.push(`upgrade-dir: ${dir} (${foundTerminal})`)
    upgradeDir = dir
    terminal = foundTerminal
    if (foundTerminal === 'running' && signal === 'none') signal = 'upgrade-dir'
    if (foundTerminal === 'failed' && signal === 'none') signal = 'upgrade-dir'
  }

  if (maintenance.autoDetect) {
    const restarters = detectRestarters({
      patterns: config.arbitration.restarterPatterns,
      excludePid: process.pid,
      maxAgeMs: maintenance.lookbackMs,
    })
    if (restarters.length > 0) {
      signals.push(`restarter-processes: ${restarters.map((p) => p.pid).join(',')}`)
      if (signal === 'none') signal = 'package-manager'
    }
  }

  const active = signal !== 'none'
  if (active) until = Math.max(until ?? 0, now + maintenance.graceMs)

  // The upgrade is terminal only if no process still looks like it is working.
  /** @type {{ pid: number, cmdline: string }[]} */
  const restarters = maintenance.autoDetect
    ? detectRestarters({ patterns: config.arbitration.restarterPatterns, excludePid: process.pid, maxAgeMs: maintenance.lookbackMs })
    : []

  if (signal === 'upgrade-dir' && terminal === 'running' && restarters.length === 0 && !treeIntact) {
    // The tree is mid-swap and nothing is running: do not touch anything.
    signals.push('tree-incomplete-without-restarter')
  }

  return { active, signal, signals, until, terminal, treeIntact, treeVersion: snapshot.version, upgradeDir, restarters }
}

/**
 * `npm ls -g --depth=0 --json`-style fallback that does not shell out: the
 * version in the package manifest is good enough for the baseline.
 * @param {string} pkgRoot
 */
export function readTreeVersion(pkgRoot) {
  const pkg = readJson(path.join(pkgRoot, 'package.json'), null)
  return typeof pkg?.version === 'string' ? pkg.version : ''
}

/** @param {string} command @param {string[]} args */
export function runQuiet(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}
