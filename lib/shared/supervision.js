// @ts-check
/**
 * Who owns the DSH process?
 *
 * If a real supervisor (systemd, pm2, a process manager with a restart loop)
 * owns the server, the guard must not start a competing instance: the
 * supervisor may restart it at any moment and two servers would fight over the
 * port. In that case the guard only reports.
 *
 * A container without an init process is *not* a supervisor: the container
 * stays alive even when DSH dies, which is exactly the case where nobody will
 * restart it and the guard has to.
 */
import fs from 'node:fs'

/**
 * @typedef {{ kind: 'none'|'systemd'|'pm2'|'docker-no-init'|'supervisord'|'tini'|'unknown', detail: string, mayAct: boolean }} SupervisorInfo
 */

/** @param {number} pid */
function readComm(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return ''
  }
}

/** @param {number} pid */
function readCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
  } catch {
    return ''
  }
}

function inContainer() {
  if (fs.existsSync('/.dockerenv')) return true
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8')
    return /docker|kubepods|containerd|libpod/i.test(cgroup)
  } catch {
    return false
  }
}

/**
 * @param {{ env?: Record<string, string | undefined>, ppid?: number }} [options]
 * @returns {SupervisorInfo}
 */
export function detectSupervisor({ env = process.env, ppid = process.ppid } = {}) {
  if (env.INVOCATION_ID || env.JOURNAL_STREAM || env.SYSTEMD_EXEC_PID || env.NOTIFY_SOCKET) {
    return { kind: 'systemd', detail: 'systemd unit environment detected (INVOCATION_ID/JOURNAL_STREAM)', mayAct: false }
  }
  if (env.PM2_HOME || env.pm_id || env.pm_exec_path) {
    return { kind: 'pm2', detail: 'pm2 environment detected', mayAct: false }
  }
  const parentComm = readComm(ppid)
  if (/systemd|pm2|supervisord|s6-svscan|runit|launchd/i.test(parentComm)) {
    return { kind: parentComm.includes('pm2') ? 'pm2' : 'supervisord', detail: `parent process is ${parentComm}`, mayAct: false }
  }
  const pid1Comm = readComm(1)
  if (/tini|dumb-init/i.test(pid1Comm)) {
    return { kind: 'tini', detail: 'PID 1 is a minimal init; it does not restart DSH', mayAct: true }
  }
  if (inContainer()) {
    return {
      kind: 'docker-no-init',
      detail: `container without a restart supervisor (PID 1: ${pid1Comm || 'unknown'}); nothing will restart DSH`,
      mayAct: true,
    }
  }
  if (ppid === 1) {
    return { kind: 'unknown', detail: 'parent is PID 1 and no init system was recognised', mayAct: true }
  }
  const parentCmd = readCmdline(ppid)
  if (parentCmd) return { kind: 'none', detail: `parent: ${parentCmd.slice(0, 160)}`, mayAct: true }
  return { kind: 'none', detail: '', mayAct: true }
}

/** @returns {boolean} */
export function hasDebugger() {
  return process.execArgv.some((arg) => arg.startsWith('--inspect') || arg.startsWith('--debug'))
}
