// @ts-check
/**
 * Repair actions: start DSH, verify a boot, roll back the profile patch, stop a
 * stale holder.
 *
 * These are the only places where the guard mutates the outside world, and
 * each returns a result object instead of throwing so the watcher can keep the
 * state machine moving and report what happened.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ensureDir, sleep } from './shared/paths.js'
import { httpProbe, findPidsByPort, pidAlive, pidCmdline, waitPortClosed } from './shared/probe.js'
import { parseAccessLine, readLogSegment } from './shared/diagnose.js'
import { bootAudit } from './shared/diagnose.js'
import { redactArgv } from './shared/redact.js'

/**
 * @typedef {{
 *   spawn: { ok: boolean, pid: number, offset: number, startedAt: number, logPath: string, error?: string, argv: string[] },
 *   verify: { ok: boolean, reason: string, accessLine: string, hasToken: boolean, elapsedMs: number, exit?: { code: number | null, signal: string | null }, probe?: any, note?: string, segment: string },
 * }} RepairOutcome
 */

/**
 * Start DSH detached, appending to the boot log exactly where the original host
 * wrote its output (so the launcher that scrapes the log for a fresh token
 * keeps working).
 * @param {{ spec: any, logPath: string, port: number, attempt: number }} input
 */
export function spawnDsh({ spec, logPath, port, attempt }) {
  ensureDir(path.dirname(logPath), 0o700)
  /** @type {string[]} */
  const argv = Array.isArray(spec.argvExact) && spec.argvExact.length > 0 ? spec.argvExact : spec.argv ?? []
  if (argv.length === 0) {
    return { ok: false, pid: 0, offset: 0, startedAt: Date.now(), logPath, error: 'no launch argv captured', argv: [] }
  }
  /** @type {number} */
  let offset = 0
  try {
    offset = fs.statSync(logPath).size
  } catch {
    offset = 0
  }
  /** @type {number} */
  let fd = -1
  try {
    fd = fs.openSync(logPath, 'a', 0o600)
    fs.writeSync(
      fd,
      `\n[dsh-restart-guard] starting DSH at ${new Date().toISOString()} (attempt ${attempt}, port ${port})\n`,
    )
    offset = fs.fstatSync(fd).size
  } catch (error) {
    return { ok: false, pid: 0, offset, startedAt: Date.now(), logPath, error: `cannot open boot log: ${String(error)}`, argv: redactArgv(argv) }
  }
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  try {
    child = spawn(spec.nodePath || process.execPath, argv.slice(1), {
      cwd: spec.cwd || process.cwd(),
      env: { ...process.env, ...(spec.env ?? {}) },
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    child.on('error', () => {
      /* the verify loop notices the missing pid */
    })
    child.unref()
  } catch (error) {
    try {
      fs.closeSync(fd)
    } catch {
      /* ignore */
    }
    return { ok: false, pid: 0, offset, startedAt: Date.now(), logPath, error: `spawn failed: ${String(error)}`, argv: redactArgv(argv) }
  }
  const pid = child.pid ?? 0
  try {
    fs.closeSync(fd)
  } catch {
    /* ignore */
  }
  return { ok: pid > 0, pid, offset, startedAt: Date.now(), logPath, argv: redactArgv(argv), child }
}

/**
 * Wait for one boot attempt to either serve the platform or fail.
 *
 * Readiness is judged on the bytes this attempt appended (never the whole log),
 * because an old `dsh web: http://…token=…` line would both fake readiness and
 * hand the launcher a stale token.
 * @param {{
 *   child: import('node:child_process').ChildProcess | null,
 *   logPath: string,
 *   offset: number,
 *   config: import('./shared/config.js').GuardConfig,
 *   port: number,
 *   protocol?: 'http'|'https',
 *   startedAt?: number,
 *   onTick?: (info: { elapsedMs: number, segment: string, accessLine: string }) => void,
 *   abort?: () => boolean,
 * }} input
 * @returns {Promise<RepairOutcome['verify']>}
 */
export async function verifyBoot({ child, logPath, offset, config, port, protocol = 'http', startedAt = Date.now(), onTick, abort }) {
  const deadline = startedAt + config.watchdog.bootTimeoutMs
  const settleMs = config.watchdog.settleMs
  /** @type {{ code: number | null, signal: string | null, at: number } | null} */
  let exit = null
  child?.once('exit', (code, signal) => {
    exit = { code, signal, at: Date.now() }
  })
  /** @type {string} */
  let accessLine = ''
  let hasToken = false
  let accessAt = 0
  /** @type {string} */
  let segment = ''
  let lastProbe = null
  let stableOk = 0

  while (Date.now() < deadline) {
    await sleep(400)
    if (abort?.()) {
      return { ok: false, reason: 'aborted', accessLine, hasToken, elapsedMs: Date.now() - startedAt, segment }
    }
    const read = readLogSegment(logPath, offset, config.readiness.maxReadBytes)
    segment = read.text
    if (!accessAt) {
      const access = parseAccessLine(segment, config.readiness.accessLine)
      if (access.found) {
        accessLine = access.line
        hasToken = access.hasToken
        accessAt = Date.now()
        onTick?.({ elapsedMs: accessAt - startedAt, segment, accessLine })
      }
    }
    if (exit) {
      const audit = bootAudit(segment, config.readiness.fatalPatterns)
      return {
        ok: false,
        reason: 'exit',
        accessLine,
        hasToken,
        elapsedMs: Date.now() - startedAt,
        exit: { code: exit.code, signal: exit.signal },
        note: audit.fatal ? 'fatal patterns in output' : '',
        segment,
      }
    }
    if (accessAt) {
      if (Date.now() - accessAt < settleMs) continue
      lastProbe = await httpProbe({ port, timeoutMs: 3000, protocol })
      if (lastProbe.ok) {
        const audit = bootAudit(segment, config.readiness.fatalPatterns)
        if (audit.fatal) {
          return { ok: false, reason: 'fatal-patterns', accessLine, hasToken, elapsedMs: Date.now() - startedAt, probe: lastProbe, note: audit.hits[0]?.line ?? '', segment }
        }
        return { ok: true, reason: 'ready', accessLine, hasToken, elapsedMs: Date.now() - startedAt, probe: lastProbe, segment }
      }
      if (lastProbe.kind === 'foreign') {
        return { ok: false, reason: 'foreign-listener', accessLine, hasToken, elapsedMs: Date.now() - startedAt, probe: lastProbe, segment }
      }
      continue
    }
    // No access line yet: probe anyway, but only accept after the inferred
    // settle window, and only twice in a row.
    if (Date.now() - startedAt > config.readiness.inferredSettleMs) {
      lastProbe = await httpProbe({ port, timeoutMs: 2000, protocol })
      if (lastProbe.ok) {
        stableOk += 1
        if (stableOk >= 2) {
          return {
            ok: true,
            reason: 'ready-without-access-line',
            accessLine: '',
            hasToken: false,
            elapsedMs: Date.now() - startedAt,
            probe: lastProbe,
            note: 'the boot log did not show the access line; a fresh launch token may be missing for new devices',
            segment,
          }
        }
      } else {
        stableOk = 0
      }
    }
    onTick?.({ elapsedMs: Date.now() - startedAt, segment, accessLine })
  }
  const audit = bootAudit(segment, config.readiness.fatalPatterns)
  return {
    ok: false,
    reason: 'timeout',
    accessLine,
    hasToken,
    elapsedMs: Date.now() - startedAt,
    note: audit.fatal ? audit.hits[0]?.line ?? '' : '',
    segment,
  }
}

/**
 * @param {string} profileDir
 * @returns {{ name: string, file: string, mtimeMs: number }[]}
 */
export function patchBackups(profileDir) {
  /** @type {{ name: string, file: string, mtimeMs: number }[]} */
  const out = []
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(profileDir)
  } catch {
    return out
  }
  for (const name of names) {
    if (!/^cordis\.patch\.yml\.bak-/.test(name)) continue
    const file = path.join(profileDir, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      out.push({ name, file, mtimeMs: stat.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  return out.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

/** @param {string} file @param {string} text */
function writeAtomic(file, text) {
  const tmp = `${file}.guard-tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * Validate a candidate patch file by asking DSH to compose the profile with it
 * in place. Exactly the check a human would run, and it catches both YAML
 * syntax errors and unknown loader entries.
 * @param {{ spec: any, profile: string, profileDir?: string, candidateText: string, patchPath: string }} input
 */
export function validatesPatch({ spec, profile, profileDir, candidateText, patchPath }) {
  const original = fs.readFileSync(patchPath, 'utf8')
  try {
    writeAtomic(patchPath, candidateText)
    const argv = Array.isArray(spec?.argvExact) ? spec.argvExact : []
    const bin = argv[1] || spec?.binPath || 'dsh'
    const node = spec?.nodePath || process.execPath
    const result = spawnSync(node, [bin, '--profile', profile, '--dump-config'], {
      cwd: profileDir || profile,
      env: { ...process.env, ...(spec?.env ?? {}) },
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    const clean = result.status === 0 && !/YAMLException|cannot unmarshal|failed to parse .*yaml/i.test(output)
    return { ok: clean, status: result.status, output: output.slice(0, 2000) }
  } finally {
    writeAtomic(patchPath, original)
  }
}

/**
 * Roll the profile patch back to the newest backup that actually composes.
 * The broken file is kept as `cordis.patch.yml.guard-broken-<ts>` so nothing is
 * ever destroyed.
 * @param {{ profileDir: string, profile: string, spec: any }} input
 */
export function rollbackProfilePatch({ profileDir, profile, spec }) {
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  /** @type {string} */
  let original = ''
  try {
    original = fs.readFileSync(patchPath, 'utf8')
  } catch {
    return { ok: false, error: 'cordis.patch.yml is missing', tried: [], applied: '' }
  }
  const backups = patchBackups(profileDir).slice(0, 6)
  if (backups.length === 0) return { ok: false, error: 'no cordis.patch.yml backups found', tried: [], applied: '' }
  /** @type {string[]} */
  const tried = []
  for (const backup of backups) {
    /** @type {string} */
    let candidate = ''
    try {
      candidate = fs.readFileSync(backup.file, 'utf8')
    } catch {
      continue
    }
    if (candidate === original) {
      tried.push(`${backup.name} (identical)`)
      continue
    }
    const validation = validatesPatch({ spec, profile, profileDir, candidateText: candidate, patchPath })
    if (!validation.ok) {
      tried.push(`${backup.name} (dump-config rc=${validation.status})`)
      continue
    }
    const brokenPath = `${patchPath}.guard-broken-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      writeAtomic(brokenPath, original)
      writeAtomic(patchPath, candidate)
    } catch (error) {
      try {
        writeAtomic(patchPath, original)
      } catch {
        /* ignore */
      }
      return { ok: false, error: `cannot write the rolled-back patch: ${String(error)}`, tried, applied: '' }
    }
    tried.push(`${backup.name} (ok)`)
    return { ok: true, error: '', tried, applied: backup.name, brokenPath }
  }
  return { ok: false, error: 'no backup composes cleanly', tried, applied: '' }
}

/**
 * @param {number} port
 */
export function findOccupant(port) {
  const { pids, source } = findPidsByPort(port)
  /** @type {string[]} */
  const cmdlines = []
  let isDsh = pids.length > 0
  for (const pid of pids) {
    const cmdline = pidCmdline(pid)
    const text = cmdline.join(' ')
    cmdlines.push(`${pid}: ${text}`)
    if (!/\bdsh\b|bin\.js/.test(text)) isDsh = false
  }
  return { pids, source, isDsh, cmdline: cmdlines.join(' | ').slice(0, 500) }
}

/**
 * Stop a stale holder, but only after checking that it really is a `dsh web`
 * process. Never called for foreign listeners.
 * @param {{ pid: number, port: number }} input
 */
export async function killStaleDsh({ pid, port }) {
  const cmdline = pidCmdline(pid).join(' ')
  if (!/\bdsh\b|bin\.js/.test(cmdline) || !/\bweb\b/.test(cmdline)) {
    return { ok: false, error: `refusing to kill pid ${pid}: ${cmdline.slice(0, 200)}` }
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    return { ok: false, error: `SIGTERM failed: ${String(error)}` }
  }
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) break
    await sleep(250)
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      return { ok: false, error: `SIGKILL failed: ${String(error)}` }
    }
    await sleep(500)
  }
  const closed = await waitPortClosed(port, 15000)
  return { ok: closed && !pidAlive(pid), error: closed ? '' : 'port still held after kill' }
}

/**
 * Resolve which file receives the boot output of the next launch.
 * @param {{ spec: any, config: import('./shared/config.js').GuardConfig, fallback: string }} input
 */
export function bootLogPath({ spec, config, fallback }) {
  const configured = String(config.logs.bootLogPath ?? '').trim()
  if (configured) return configured
  if (spec?.stdoutPath) return spec.stdoutPath
  return fallback
}
