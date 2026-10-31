// @ts-check
/**
 * Filesystem layout and small safe-IO helpers shared by the host plugin, the
 * detached watcher and the CLI.
 *
 * Everything derived here must stay inside the DSH home directory: the guard
 * never writes to system paths, and every file it creates is owner-only.
 */
import fs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** @param {NodeJS.ProcessEnv} [env] */
export function dshHome(env = process.env) {
  const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return raw ? resolve(expandHome(raw, env)) : join(homedir(), '.dsh')
}

/**
 * Expand a leading `~` and `$DSH_HOME` in a user-supplied path.
 * @param {string} input
 * @param {NodeJS.ProcessEnv} [env]
 */
export function expandHome(input, env = process.env) {
  let value = String(input ?? '').trim()
  if (!value) return value
  if (value === '~') value = homedir()
  else if (value.startsWith('~/')) value = join(homedir(), value.slice(2))
  // Never call dshHome() here: it calls back into this function for `$DSH_HOME`.
  const configured = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : join(homedir(), '.dsh')
  value = value.replace(/\$DSH_HOME/g, configured)
  return value
}

/** @param {NodeJS.ProcessEnv} [env] */
export function guardRoot(env = process.env) {
  return join(dshHome(env), 'restart-guard')
}

/** @param {NodeJS.ProcessEnv} [env] */
export function configPath(env = process.env) {
  return join(guardRoot(env), 'config.json')
}

/** @param {unknown} value */
export function sanitizeId(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'default'
}

/**
 * @param {string | undefined} profile
 * @param {number | string | undefined} port
 */
export function instanceId(profile, port) {
  return `${sanitizeId(profile || 'default')}-${sanitizeId(port ?? 'unknown')}`
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string | undefined} profile
 * @param {number | string | undefined} port
 */
export function instanceDir(env, profile, port) {
  return join(guardRoot(env), 'instances', instanceId(profile, port))
}

/** @param {string} dir @param {number} [mode] */
export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode })
  try {
    fs.chmodSync(dir, mode)
  } catch {
    /* best effort: some filesystems refuse chmod */
  }
  return dir
}

/**
 * @param {string} file
 * @param {any} [fallback]
 * @returns {any}
 */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Atomic JSON write: temp file in the same directory, chmod, rename.
 * @param {string} file
 * @param {unknown} value
 * @param {number} [mode]
 */
export function writeJsonAtomic(file, value, mode = 0o600) {
  ensureDir(dirname(file), 0o700)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const body = `${JSON.stringify(value, null, 2)}\n`
  fs.writeFileSync(tmp, body, { mode })
  try {
    fs.chmodSync(tmp, mode)
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, file)
  return value
}

/**
 * Append text to an owner-only log, refusing to follow symlinks.
 * @param {string} file
 * @param {string} text
 * @param {number} [mode]
 */
export function appendLine(file, text, mode = 0o600) {
  ensureDir(dirname(file), 0o700)
  const fd = openAppendNoFollow(file, mode)
  try {
    fs.writeSync(fd, text.endsWith('\n') ? text : `${text}\n`)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * `O_NOFOLLOW` is the whole point: a local attacker must not be able to point
 * our root-owned append at an arbitrary file through a symlink.
 * @param {string} file
 * @param {number} [mode]
 */
export function openAppendNoFollow(file, mode = 0o600) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW
  try {
    return fs.openSync(file, flags, mode)
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENOTDIR') {
      throw new Error(`refusing to write through a symlink or non-regular path: ${file}`)
    }
    throw error
  }
}

/**
 * @param {string} file
 * @returns {fs.Stats | null}
 */
export function statSafe(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/**
 * @param {string} file
 * @returns {string | null}
 */
export function realpathSafe(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return null
  }
}

/**
 * True when `child` resolves inside `parent` (after symlink resolution).
 * @param {string} parent
 * @param {string} child
 */
export function isInside(parent, child) {
  const a = realpathSafe(parent)
  const b = realpathSafe(child)
  if (!a || !b) return false
  return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`)
}

/**
 * @param {string} file
 * @returns {number}
 */
export function mtimeMs(file) {
  return statSafe(file)?.mtimeMs ?? 0
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

