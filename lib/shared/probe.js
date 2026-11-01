// @ts-check
/**
 * Platform probes: HTTP liveness, port→PID attribution, process inspection and
 * small timing helpers.
 *
 * Linux is the first-class platform (/proc). macOS degrades to `lsof`/`ps`; when
 * neither is available the guard still works, it just reports "unknown" for
 * process attribution instead of guessing.
 */
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { sleep } from './paths.js'

/** @typedef {{ ok: boolean, kind: 'dsh'|'foreign'|'unexpected'|'down', status: number, snippet: string, error?: string }} ProbeResult */

/**
 * Liveness probe against the web server root.
 *
 * Healthy means one of:
 *  - 401 with the DSH auth body (the launcher's own health convention), or
 *  - 200 whose HTML contains the `__DSH_BOOT__` marker.
 * Anything else — including a 200 from some unrelated service that grabbed the
 * port — is not DSH.
 *
 * @param {{ port: number, host?: string, timeoutMs?: number, protocol?: 'http'|'https' }} options
 * @returns {Promise<ProbeResult>}
 */
export function httpProbe({ port, host = '127.0.0.1', timeoutMs = 3000, protocol = 'http' }) {
  const transport = protocol === 'https' ? https : http
  return new Promise((resolve) => {
    /** @type {import('node:http').ClientRequest | undefined} */
    let req
    const done = (/** @type {ProbeResult} */ result) => {
      try {
        req?.destroy()
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    try {
      req = transport.request(
        {
          host,
          port,
          path: '/',
          method: 'GET',
          agent: false,
          timeout: timeoutMs,
          rejectUnauthorized: false,
          headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'user-agent': 'dsh-restart-guard' },
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            if (body.length < 16384) body += chunk
          })
          res.on('error', () => done({ ok: false, kind: 'down', status: 0, snippet: '', error: 'response' }))
          res.on('end', () => done(classify(res.statusCode ?? 0, body)))
        },
      )
      req.on('timeout', () => {
        req?.destroy(new Error('timeout'))
      })
      req.on('error', (error) => {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code || error.message
        done({ ok: false, kind: 'down', status: 0, snippet: '', error: String(code) })
      })
      req.end()
    } catch (error) {
      done({ ok: false, kind: 'down', status: 0, snippet: '', error: String(error) })
    }
  })
}

/**
 * @param {number} status
 * @param {string} body
 * @returns {{ ok: boolean, kind: 'dsh'|'foreign'|'unexpected'|'down', status: number, snippet: string }}
 */
export function classifyProbe(status, body) {
  const snippet = String(body ?? '').slice(0, 240)
  if (status === 401 && /dsh web authentication required/i.test(body)) {
    return { ok: true, kind: 'dsh', status, snippet }
  }
  if (status === 200 && body.includes('__DSH_BOOT__')) {
    return { ok: true, kind: 'dsh', status, snippet }
  }
  if (status === 200 || status === 302 || status === 403) {
    return { ok: false, kind: 'foreign', status, snippet }
  }
  return { ok: false, kind: 'unexpected', status, snippet }
}

const classify = classifyProbe

/**
 * @param {number} port
 * @param {{ host?: string, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function portOpen(port, { host = '127.0.0.1', timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const finish = (value) => {
      if (timer) clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * @param {number} port
 * @param {number} timeoutMs
 * @param {number} [intervalMs]
 */
export async function waitPortClosed(port, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portOpen(port, { timeoutMs: 400 }))) return true
    await sleep(intervalMs)
  }
  return !(await portOpen(port, { timeoutMs: 400 }))
}

/**
 * Kernel state of a process. A killed container child is often reparented to
 * PID 1, and PID 1 does not always reap: the process stays as `Z` (zombie)
 * forever, still answering `kill -0` while holding no port and no code.
 * @param {number} pid
 * @returns {{ state: string, zombie: boolean, dead: boolean }}
 */
export function readProcessState(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) {
    return { state: '', zombie: false, dead: false }
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close === -1) return { state: '', zombie: false, dead: false }
    const state = stat.slice(close + 2, close + 3)
    return { state, zombie: state === 'Z', dead: state === 'X' || state === 'x' }
  } catch {
    // No /proc entry: the pid is gone.
    return { state: '', zombie: false, dead: true }
  }
}

/** @param {number} pid */
export function isZombie(pid) {
  return readProcessState(pid).zombie
}

/**
 * True when the pid no longer runs code. A zombie counts as gone: it cannot
 * serve a port, cannot be killed, and its parent (often PID 1) never reaps it.
 * @param {number} pid
 */
export function pidGone(pid) {
  return !pidAlive(pid)
}

/** @param {number} pid */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (process.platform === 'linux') {
    const info = readProcessState(pid)
    if (info.dead || info.zombie) return false
    if (info.state) return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'
  }
}

/**
 * @param {number} pid
 * @returns {string[]}
 */
export function pidCmdline(pid, fallback = true) {
  if (process.platform === 'linux') {
    // A zombie has an empty cmdline; `ps` would print "[MainThread] <defunct>",
    // which looks like a real command line and breaks identity checks.
    if (isZombie(pid)) return []
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const parts = raw.split('\0').filter((part) => part.length > 0)
      if (parts.length > 0) return parts
    } catch {
      /* fall through to ps */
    }
    // Spawning `ps` for every kernel thread or already-dead pid turns a
    // process scan into a multi-second stall; a /proc scan only wants the
    // processes that actually expose a command line.
    if (!fallback) return []
  }
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 })
  if (ps.status === 0 && ps.stdout.trim()) return [ps.stdout.trim()]
  return []
}

/**
 * `/proc/stat` is re-read for every process otherwise, which turns a process
 * scan into a multi-second operation on a busy host. The boot time never
 * changes while the machine is up, so read it once.
 * @type {number}
 */
let bootTimeCache = 0

/** @returns {number} boot time in seconds since the epoch, 0 when unknown */
function bootTimeSeconds() {
  if (bootTimeCache > 0) return bootTimeCache
  try {
    const match = /^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'))
    bootTimeCache = match ? Number(match[1]) : 0
  } catch {
    bootTimeCache = 0
  }
  return bootTimeCache
}

/**
 * Start time in ms since epoch, used to tell "the same PID" from "a recycled
 * PID". Returns 0 when the platform does not expose it.
 * @param {number} pid
 */
export function processStartTimeMs(pid) {
  if (process.platform !== 'linux') return 0
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close === -1) return 0
    const fields = stat.slice(close + 2).trim().split(/\s+/)
    // After "comm)": state(3) ppid(4) ... starttime is field 22 overall.
    const startTicks = Number(fields[19])
    if (!Number.isFinite(startTicks)) return 0
    const btime = bootTimeSeconds()
    if (!btime) return 0
    const hz = 100
    return (btime + startTicks / hz) * 1000
  } catch {
    return 0
  }
}

/**
 * @typedef {{ pid: number, cmdline: string[], startMs: number }} ProcessInfo
 */

/**
 * @param {number} [limit]
 * @returns {ProcessInfo[]}
 */
export function listProcesses(limit = 4000) {
  /** @type {ProcessInfo[]} */
  const out = []
  if (process.platform === 'linux') {
    /** @type {string[]} */
    let names = []
    try {
      names = fs.readdirSync('/proc')
    } catch {
      return out
    }
    for (const name of names) {
      if (out.length >= limit) break
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name)
      const cmdline = pidCmdline(pid, false)
      if (cmdline.length === 0) continue
      out.push({ pid, cmdline, startMs: processStartTimeMs(pid) })
    }
    return out
  }
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 })
  if (ps.status !== 0) return out
  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    out.push({ pid: Number(match[1]), cmdline: [match[2].trim()], startMs: 0 })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Socket inode → owning PIDs, from /proc.
 * @param {Set<string>} inodes
 * @returns {Map<string, number[]>}
 */
function inodeOwners(inodes) {
  /** @type {Map<string, number[]>} */
  const owners = new Map()
  if (process.platform !== 'linux' || inodes.size === 0) return owners
  /** @type {string[]} */
  let pids = []
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return owners
  }
  for (const name of pids) {
    const pid = Number(name)
    /** @type {string[]} */
    let fds = []
    try {
      fds = fs.readdirSync(`/proc/${name}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let target = ''
      try {
        target = fs.readlinkSync(`/proc/${name}/fd/${fd}`)
      } catch {
        continue
      }
      const match = /^socket:\[(\d+)\]$/.exec(target)
      if (!match) continue
      if (!inodes.has(match[1])) continue
      const list = owners.get(match[1]) ?? []
      if (!list.includes(pid)) list.push(pid)
      owners.set(match[1], list)
    }
  }
  return owners
}

/**
 * Listening-port → inode map from /proc/net/tcp{6}.
 * @returns {Map<number, Set<string>>}
 */
function procListening() {
  /** @type {Map<number, Set<string>>} */
  const map = new Map()
  if (process.platform !== 'linux') return map
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    /** @type {string} */
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n').slice(1)
    for (const line of lines) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 10) continue
      const [local, , , state, , , , , , inode] = [fields[1], fields[2], fields[3], fields[3], fields[4], fields[5], fields[6], fields[7], fields[8], fields[9]]
      if (state !== '0A') continue
      const portHex = local?.split(':')[1]
      if (!portHex) continue
      const port = Number.parseInt(portHex, 16)
      if (!Number.isFinite(port)) continue
      const set = map.get(port) ?? new Set()
      if (inode && inode !== '0') set.add(inode)
      map.set(port, set)
    }
  }
  return map
}

/**
 * @param {number} port
 * @returns {{ pids: number[], source: 'proc'|'lsof'|'none' }}
 */
export function findPidsByPort(port) {
  const listening = procListening()
  const inodes = listening.get(port)
  if (inodes && inodes.size > 0) {
    const owners = inodeOwners(inodes)
    /** @type {number[]} */
    const pids = []
    for (const list of owners.values()) for (const pid of list) if (!pids.includes(pid)) pids.push(pid)
    if (pids.length > 0) return { pids, source: 'proc' }
  }
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 4000 })
  if (lsof.status === 0 && lsof.stdout.trim()) {
    const pids = lsof.stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    if (pids.length > 0) return { pids, source: 'lsof' }
  }
  return { pids: [], source: 'none' }
}

/**
 * @param {number} port
 * @returns {Promise<number[]>}
 */
export async function waitForListenerPid(port, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { pids } = findPidsByPort(port)
    if (pids.length > 0) return pids
    await sleep(intervalMs)
  }
  return []
}

/** @param {string} command */
export function commandExists(command) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8', timeout: 3000 })
  return probe.status === 0 && Boolean(probe.stdout.trim())
}
