// @ts-check
/**
 * Launch-spec capture.
 *
 * When the platform is down, the guard has to start DSH the same way it was
 * started: same argv, same cwd, same environment. Capturing that at the moment
 * the host is healthy is the only reliable way (once the process is gone,
 * /proc is gone with it), so the spec is written to the instance directory
 * with mode 0600 and refreshed while the host is alive.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from './paths.js'
import { isSensitiveKey, redactArgv } from './redact.js'

/**
 * @typedef {{
 *   argv: string[],
 *   env: Record<string, string>,
 *   cwd: string,
 *   nodePath: string,
 *   binPath: string,
 *   pkgRoot: string,
 *   pid: number,
 *   startMs: number,
 *   stdoutPath: string,
 *   capturedAt: number,
 * }} LaunchSpec
 */

/** Keys we never persist, even in a 0600 file. */
const BLOCKED_ENV = /(token|secret|password|passwd|credential|cookie|private[_-]?key|api[_-]?key)/i

/** Everything DSH itself and a Node process needs to boot the same way. */
const ALLOWED_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|TERM|TMPDIR|PWD|OLDPWD|SHLVL|PAGER|EDITOR|VISUAL|XDG_[A-Z_]+|DSH_[A-Z0-9_]+|NODE_[A-Z0-9_]+|NPM_[A-Z0-9_]+|LC_[A-Z]+|(?:HTTP|HTTPS|NO|ALL)_PROXY|NO_COLOR|FORCE_COLOR|CI|VIPSHOME|YARN_VERSION)$/i

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function filterEnv(env) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string') continue
    if (value.length > 8192) continue
    if (BLOCKED_ENV.test(key)) continue
    if (!ALLOWED_ENV.test(key)) continue
    out[key] = value
  }
  return out
}

/** @param {string} binPath */
function derivePkgRoot(binPath) {
  try {
    const real = fs.realpathSync(binPath)
    if (real.endsWith('/lib/bin.js')) return path.dirname(path.dirname(real))
  } catch {
    /* ignore */
  }
  return ''
}

/** @param {string} binPath */
function deriveNodePath(binPath) {
  try {
    return fs.realpathSync('/proc/self/exe')
  } catch {
    void binPath
    return process.execPath
  }
}

/**
 * Read the live spec of a running host process.
 * @param {number} pid
 * @returns {LaunchSpec | null}
 */
export function captureLaunch(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null
  /** @type {string[]} */
  let argv = []
  try {
    argv = fs
      .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .filter((part) => part.length > 0)
  } catch {
    return null
  }
  if (argv.length === 0) return null
  /** @type {Record<string, string>} */
  let rawEnv = {}
  try {
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const index = entry.indexOf('=')
      if (index <= 0) continue
      rawEnv[entry.slice(0, index)] = entry.slice(index + 1)
    }
  } catch {
    return null
  }
  /** @type {string} */
  let cwd = ''
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    cwd = process.cwd()
  }
  const binPath = argv[1] && argv[1].includes('/') ? argv[1] : '/usr/local/bin/dsh'
  /** @type {string} */
  let nodePath = ''
  try {
    nodePath = fs.readlinkSync(`/proc/${pid}/exe`)
  } catch {
    nodePath = process.execPath
  }
  /** @type {number} */
  let startMs = 0
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    const ticks = Number(stat.slice(close + 2).trim().split(/\s+/)[19])
    const btime = Number(/^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1] ?? 0)
    if (Number.isFinite(ticks) && btime) startMs = (btime + ticks / 100) * 1000
  } catch {
    /* ignore */
  }
  let stdoutPath = ''
  try {
    const target = fs.readlinkSync(`/proc/${pid}/fd/1`)
    if (target.startsWith('/')) stdoutPath = target
  } catch {
    stdoutPath = ''
  }
  return {
    argv,
    env: filterEnv(rawEnv),
    cwd: cwd || process.cwd(),
    nodePath: nodePath || process.execPath,
    binPath,
    pkgRoot: derivePkgRoot(binPath),
    pid,
    startMs,
    stdoutPath,
    capturedAt: Date.now(),
  }
}

/**
 * The spec of *this* process — used when the watcher is started by the host and
 * the host cannot be read (non-Linux, or /proc restricted).
 * @returns {LaunchSpec}
 */
export function captureSelf() {
  const argv = [process.execPath, ...process.argv.slice(1)]
  const binPath = process.argv[1] ?? ''
  return {
    argv,
    env: filterEnv(process.env),
    cwd: process.cwd(),
    nodePath: process.execPath,
    binPath,
    pkgRoot: derivePkgRoot(binPath),
    pid: process.pid,
    startMs: Date.now(),
    stdoutPath: '',
    capturedAt: Date.now(),
  }
}

/**
 * @param {string} instanceDir
 * @param {LaunchSpec} spec
 */
export function storeLaunchSpec(instanceDir, spec) {
  ensureDir(instanceDir, 0o700)
  const payload = {
    ...spec,
    argv: redactArgv(spec.argv),
    // The full argv is needed to replay the launch, the redacted one is for
    // display. Keep both: `argv` (redacted) is what the UI sees, `argvExact`
    // is mode-0600 only.
    argvExact: spec.argv,
  }
  writeJsonAtomic(path.join(instanceDir, 'launch.json'), payload, 0o600)
  return payload
}

/**
 * @param {string} instanceDir
 * @returns {(LaunchSpec & { argvExact?: string[] }) | null}
 */
export function loadLaunchSpec(instanceDir) {
  const payload = readJson(path.join(instanceDir, 'launch.json'), null)
  if (!payload) return null
  return payload
}

/** @param {LaunchSpec} spec */
export function specSummary(spec) {
  const args = redactArgv(spec.argv ?? [])
  return {
    node: spec.nodePath,
    argv: args,
    cwd: spec.cwd,
    envKeys: Object.keys(spec.env ?? {}).sort(),
    pid: spec.pid,
  }
}

/** @param {string} binPath */
export function nodePathFor(binPath) {
  return deriveNodePath(binPath)
}
