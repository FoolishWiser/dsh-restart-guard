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
import { classifyReachability, findPidsByPort, isZombie, pidAlive, pidCmdline, pidGone, portOpen, probeDshStack, waitPortClosed } from './shared/probe.js'
import { parseAccessLine, readLogSegment } from './shared/diagnose.js'
import { bootAudit } from './shared/diagnose.js'
import { redactArgv, redactText } from './shared/redact.js'
import { isProtectedPackage } from './shared/ai.js'

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
 * True when the boot log shows DSH aborted activation even if the process kept
 * running and still answers on the port (dsh prints a StartupError diagnostic
 * and stays alive, so a 401 alone is not proof of a healthy boot).
 * @param {string} text
 * @returns {{ failed: boolean, hit: string }}
 */
function startupFailureIn(text) {
  const hit = text.match(/(?:^|\n)(?:dsh: )?startup failed:[^\n]*|Failed plugins \(\d+\)[^\n]*|required plugin\(s\) did not activate|required plugin did not activate/i)
  return { failed: hit !== null, hit: hit === null ? '' : hit[0] }
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
  let inferredAt = 0
  let hangSince = 0

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
      lastProbe = await probeDshStack({ port, timeoutMs: 3000, protocol })
      if (!lastProbe.ok) {
        // A third-party plugin (an auth gate, a proxy) can keep the kernel
        // socket open while `/` never answers. That is a hanging server, not a
        // dead one: killing it would take down a host that is actually up.
        const reach = classifyReachability(lastProbe, await portOpen(port, { timeoutMs: 800 }))
        if (reach === 'hanging') {
          if (!hangSince) hangSince = Date.now()
          const hangMs = Date.now() - hangSince
          if (hangMs >= (Number(config.watchdog.hangConfirmMs) || 20000)) {
            return {
              ok: false,
              reason: 'http-hanging',
              accessLine,
              hasToken,
              elapsedMs: Date.now() - startedAt,
              probe: lastProbe,
              note: `the port accepts TCP but HTTP did not answer for ${Math.round(hangMs / 1000)}s`,
              segment,
            }
          }
        } else {
          hangSince = 0
        }
      }
      if (lastProbe.ok) {
        // A required-plugin failure is the decisive signal: it names the
        // plugin and the phase that failed, so report it before the generic
        // pattern audit (which also trips on harmless "1 entry did not
        // activate" warnings from optional plugins).
        const aborted = startupFailureIn(segment)
        if (aborted.failed) {
          return { ok: false, reason: 'startup-failed', accessLine, hasToken, elapsedMs: Date.now() - startedAt, probe: lastProbe, note: aborted.hit, segment }
        }
        const audit = bootAudit(segment, config.readiness.fatalPatterns)
        const serious = audit.hits.filter((/** @type {{ line: string }} */ hit) => !/warning:|already owned|did not activate/i.test(hit.line))
        if (audit.fatal && serious.length > 0) {
          return { ok: false, reason: 'fatal-patterns', accessLine, hasToken, elapsedMs: Date.now() - startedAt, probe: lastProbe, note: serious[0]?.line ?? '', segment }
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
      lastProbe = await probeDshStack({ port, timeoutMs: 2000, protocol })
      if (lastProbe.ok) {
        stableOk += 1
        if (stableOk >= 2) {
          if (!inferredAt) inferredAt = Date.now()
          if (Date.now() - inferredAt >= (Number(config.readiness.inferredQuietMs) || 0)) {
            const aborted = startupFailureIn(segment)
            if (aborted.failed) {
              return { ok: false, reason: 'startup-failed', accessLine, hasToken, elapsedMs: Date.now() - startedAt, probe: lastProbe, note: aborted.hit, segment }
            }
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
        }
      } else {
        stableOk = 0
        inferredAt = 0
      }
    }
    onTick?.({ elapsedMs: Date.now() - startedAt, segment, accessLine })
  }
  const audit = bootAudit(segment, config.readiness.fatalPatterns)
  const aborted = startupFailureIn(segment)
  if (aborted.failed) {
    return { ok: false, reason: 'startup-failed', accessLine, hasToken, elapsedMs: Date.now() - startedAt, note: aborted.hit, segment }
  }
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
  // A process that is already gone or reaped into a zombie cannot hold the
  // port and cannot be killed; the caller must go on and start a new server.
  if (pidGone(pid) || isZombie(pid)) {
    const reason = isZombie(pid) ? 'zombie' : 'gone'
    return { ok: true, skipped: reason, error: '' }
  }
  try {
    if (await portOpen(port, { timeoutMs: 800 })) {
      const probe = await probeDshStack({ port, timeoutMs: 3000 })
      if (probe.ok) {
        const where = probe.kind === 'gateway' ? ` (gateway on :${port} -> core :${probe.corePort})` : ''
        return { ok: false, skipped: 'answering', error: `refusing to kill pid ${pid}: the port still answers HTTP${where}` }
      }
      if (classifyReachability(probe, true) === 'hanging') {
        return {
          ok: false,
          skipped: 'hanging',
          error: `refusing to kill pid ${pid}: the port accepts TCP but HTTP does not answer`,
        }
      }
    }
  } catch {
    /* a failed pre-check must not block the zombie/gone paths above */
  }
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
  const gone = pidGone(pid)
  return { ok: closed && gone, skipped: '', error: closed ? '' : `pid ${pid} still running or port still held after kill` }
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


/**
 * Resolve the package that owns a failing loader entry. The AI may only edit
 * files inside this directory.
 *
 * @param {{ profileDir: string, entryName: string }} input
 * @returns {{ ok: true, dir: string } | { ok: false, error: string }}
 */
export function resolveFailingPackage({ profileDir, entryName }) {
  const name = String(entryName || '').trim()
  if (!name) return { ok: false, error: 'the boot log did not name the failing package' }
  if (isProtectedPackage(name)) return { ok: false, error: `${name} is a core package and is never edited by AI` }
  const home = path.dirname(path.dirname(path.resolve(profileDir)))
  const target = path.join(profileDir, 'node_modules', name)
  /** @type {string} */
  let dir = ''
  try {
    dir = fs.realpathSync(target)
  } catch {
    return { ok: false, error: `${name} is not installed at ${target}` }
  }
  let isDir = false
  try {
    isDir = fs.statSync(dir).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) return { ok: false, error: `${dir} is not a directory` }
  if (!(dir === home || dir.startsWith(`${home}${path.sep}`))) {
    return { ok: false, error: `${dir} is outside ${home}; refusing to edit it` }
  }
  return { ok: true, dir }
}

/**
 * @param {string} abs
 * @returns {string} an error message, or '' when the file parses
 */
function checkEditedFile(abs) {
  if (/\.(js|mjs|cjs)$/.test(abs)) {
    const result = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 20000 })
    if (result.status !== 0) {
      const line = `${result.stderr ?? ''}`.split('\n').find((item) => /SyntaxError|Error:/.test(item)) ?? 'syntax check failed'
      return `\`node --check ${path.basename(abs)}\` failed: ${line.trim()}`
    }
  }
  if (/\.json$/.test(abs)) {
    try {
      JSON.parse(fs.readFileSync(abs, 'utf8'))
    } catch (/** @type {any} */ error) {
      return `invalid JSON: ${String(error?.message ?? error)}`
    }
  }
  return ''
}

/**
 * Apply AI-authored file edits inside one plugin directory. Every file is backed
 * up first; if any write or syntax check fails, all files are restored.
 *
 * @param {{ packageDir: string, edits: Array<{ file: string, content: string }>, stamp?: string }} input
 * @returns {{ ok: true, changed: Array<{ file: string, abs: string, backup: string, bytes: number }>, error: '' } | { ok: false, changed: [], error: string }}
 */
export function applyAiEdits({ packageDir, edits, stamp }) {
  /** @type {string} */
  let dir = ''
  try {
    dir = fs.realpathSync(packageDir)
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory')
  } catch (/** @type {any} */ error) {
    return { ok: false, changed: [], error: `cannot resolve ${packageDir}: ${String(error?.message ?? error)}` }
  }
  const ts = stamp || new Date().toISOString().replace(/[:.]/g, '-')
  /** @type {Array<{ file: string, abs: string, backup: string, bytes: number }>} */
  const changed = []
  const restore = () => {
    for (const item of changed.slice().reverse()) {
      try {
        fs.copyFileSync(item.backup, item.abs)
      } catch {
        /* best effort */
      }
    }
  }
  for (const edit of edits) {
    const rel = String(edit.file || '').replace(/\\/g, '/').trim()
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) {
      restore()
      return { ok: false, changed: [], error: `edit path "${edit.file}" must stay inside the package` }
    }
    const abs = path.resolve(dir, rel)
    if (!abs.startsWith(`${dir}${path.sep}`)) {
      restore()
      return { ok: false, changed: [], error: `edit path "${rel}" escapes ${dir}` }
    }
    /** @type {fs.Stats} */
    let stat
    try {
      stat = fs.lstatSync(abs)
    } catch {
      restore()
      return { ok: false, changed: [], error: `${rel} does not exist inside the plugin; the model may only change existing files` }
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      restore()
      return { ok: false, changed: [], error: `${rel} is not a regular file` }
    }
    const real = fs.realpathSync(abs)
    if (!real.startsWith(`${dir}${path.sep}`)) {
      restore()
      return { ok: false, changed: [], error: `${rel} points outside the package` }
    }
    const content = String(edit.content ?? '')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > 64 * 1024) {
      restore()
      return { ok: false, changed: [], error: `${rel} is ${bytes} bytes; the limit is 65536` }
    }
    const backup = `${abs}.guard-bak-${ts}`
    try {
      fs.copyFileSync(abs, backup)
      fs.chmodSync(backup, 0o600)
      const tmp = `${abs}.guard-tmp-${process.pid}`
      fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: stat.mode & 0o777 })
      fs.renameSync(tmp, abs)
    } catch (/** @type {any} */ error) {
      restore()
      return { ok: false, changed: [], error: `cannot write ${rel}: ${String(error?.message ?? error)}` }
    }
    changed.push({ file: rel, abs, backup, bytes })
    const problem = checkEditedFile(abs)
    if (problem) {
      restore()
      return { ok: false, changed: [], error: `${rel}: ${problem}` }
    }
  }
  return { ok: true, changed, error: '' }
}

/**
 * Put the files exactly as they were before an AI edit round.
 * @param {{ changed: Array<{ file: string, abs: string, backup: string }> }} input
 */
export function restoreAiEdits({ changed }) {
  let restored = 0
  /** @type {string[]} */
  const errors = []
  for (const item of Array.isArray(changed) ? changed : []) {
    try {
      fs.copyFileSync(item.backup, item.abs)
      restored += 1
    } catch (/** @type {any} */ error) {
      errors.push(`${item.file}: ${String(error?.message ?? error)}`)
    }
  }
  return { ok: errors.length === 0, restored, errors }
}

/**
 * Disable one loader entry through the profile patch layer. This is the fallback
 * when the plugin cannot be repaired: DSH then boots without it.
 *
 * @param {{ profileDir: string, profile: string, spec: any, entryId: string, entryName?: string }} input
 */
export function disablePatchEntry({ profileDir, profile, spec, entryId, entryName }) {
  const id = String(entryId || '').trim()
  if (!id) return { ok: false, error: 'no loader entry id to disable', backup: '', patchPath: '' }
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  /** @type {string} */
  let original = ''
  try {
    original = fs.readFileSync(patchPath, 'utf8')
  } catch {
    return { ok: false, error: 'cordis.patch.yml is missing', backup: '', patchPath }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const nameLine = entryName ? `- id: ${id}\n  name: ${JSON.stringify(entryName)}\n  disabled: true\n` : `- id: ${id}\n  disabled: true\n`
  const addition = `\n# dsh-restart-guard: the AI could not repair this plugin (${new Date().toISOString()}); boot without it\n${nameLine}`
  const candidate = original + addition
  const validation = validatesPatch({ spec, profile, profileDir, candidateText: candidate, patchPath })
  if (!validation.ok) {
    return { ok: false, error: `the disabled entry does not compose (rc=${validation.status}): ${validation.output.slice(0, 400)}`, backup: '', patchPath }
  }
  const backup = `${patchPath}.guard-disabled-${ts}`
  try {
    fs.copyFileSync(patchPath, backup)
    fs.chmodSync(backup, 0o600)
    writeAtomic(patchPath, candidate)
  } catch (/** @type {any} */ error) {
    try {
      writeAtomic(patchPath, original)
    } catch {
      /* ignore */
    }
    return { ok: false, error: `cannot write the patch: ${String(error?.message ?? error)}`, backup: '', patchPath }
  }
  return { ok: true, error: '', backup, patchPath, entryId: id }
}

/** @param {{ patchPath: string, backup: string }} input */
export function restorePatchEntry({ patchPath, backup }) {
  try {
    const text = fs.readFileSync(backup, 'utf8')
    writeAtomic(patchPath, text)
    return { ok: true, error: '' }
  } catch (/** @type {any} */ error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * Package briefing for the AI: what the plugin is, its manifest, entry file and
 * root config files, all redacted and bounded.
 *
 * @param {{ packageDir: string, entryId?: string, entryName?: string, required?: boolean, maxBytes?: number }} input
 */
export function buildPluginMaterial({ packageDir, entryId, entryName, required, maxBytes }) {
  const budget = Math.max(4096, Number(maxBytes) || 32 * 1024)
  /** @type {string[]} */
  const parts = []
  parts.push('## Failing plugin')
  parts.push(`- entry: ${entryId || 'unknown'}${required ? ' (required)' : ''}`)
  parts.push(`- package: ${entryName || 'unknown'}`)
  parts.push(`- directory: ${packageDir}`)
  let used = 0
  /** @type {string[]} */
  let files = []
  try {
    files = fs.readdirSync(packageDir).filter((name) => /\.(json|ya?ml|js|mjs|cjs)$/.test(name)).sort()
  } catch {
    files = []
  }
  /** @type {Record<string, any>} */
  let manifest = {}
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  } catch {
    manifest = {}
  }
  const entry = typeof manifest.main === 'string' && manifest.main ? manifest.main.replace(/^\.\//, '') : 'index.js'
  const order = [entry, 'package.json', ...files.filter((name) => name !== entry && name !== 'package.json')]
  const seen = new Set()
  for (const name of order) {
    if (seen.has(name)) continue
    seen.add(name)
    const abs = path.join(packageDir, name)
    /** @type {string} */
    let text = ''
    try {
      const stat = fs.lstatSync(abs)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const remaining = budget - used
    if (remaining < 512) break
    const clipped = text.length > remaining ? `${text.slice(0, remaining)}\n… (truncated)` : text
    used += Buffer.byteLength(clipped, 'utf8')
    parts.push('', `### ${name}`, '```' + (name.endsWith('.json') ? 'json' : name.endsWith('.yml') || name.endsWith('.yaml') ? 'yaml' : 'js') , redactText(clipped), '```')
  }
  return parts.join('\n')
}
