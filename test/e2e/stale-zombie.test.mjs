// @ts-check
/**
 * pid.json can point at a process that is now a zombie (killed host, PID 1
 * never reaped). That is a dead host, not a stalled one: the guard must start
 * a fresh server instead of trying to kill something that cannot be killed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { saveConfig } from '../../lib/shared/config.js'
import { instanceDir, readJson } from '../../lib/shared/paths.js'
import { findPidsByPort } from '../../lib/shared/probe.js'
import { fakeTree, freePort, profileDir, tmpHome, waitFor, writeFakeLaunch } from '../helpers.mjs'

const watcherPath = path.join(import.meta.dirname, '..', '..', 'lib', 'watcher.mjs')
const python = process.platform === 'linux' && spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0

test('a zombie host pid does not block recovery', { skip: !python, timeout: 60000 }, async () => {
  const home = tmpHome()
  const port = await freePort(4050)
  const logPath = path.join(home, 'boot.log')
  const env = { DSH_HOME: home }
  const dir = instanceDir(env, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  profileDir(home, 'web')
  const tree = fakeTree(home)
  writeFakeLaunch(dir, { port, logPath, mode: 'ok', binPath: tree.binPath, pkgRoot: tree.pkgRoot })
  saveConfig(
    {
      watchdog: { probeIntervalMs: 500, probeTimeoutMs: 1000, startupGraceMs: 1000, stalledExitMs: 3000, bootTimeoutMs: 8000, settleMs: 200, maxRestartAttempts: 2 },
      maintenance: { autoDetect: false },
      supervision: { mode: 'none' },
      logs: { bootLogPath: logPath },
      notify: { command: { enabled: false, program: '', args: [] } },
    },
    { env },
  )

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-sz-'))
  const pidFile = path.join(tmp, 'child.pid')
  const script = [
    'import subprocess, sys, time',
    'child = subprocess.Popen(["sleep", "300"])',
    'open(sys.argv[1], "w").write(str(child.pid))',
    'time.sleep(300)',
  ].join('\n')
  const keeper = spawn('python3', ['-c', script, pidFile], { stdio: 'ignore' })
  const watcher = spawn(
    process.execPath,
    [watcherPath, '--home', home, '--profile', 'web', '--port', String(port), '--instance', dir],
    { env: { ...process.env, ...env }, stdio: 'ignore' },
  )
  try {
    await waitFor(() => (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() ? true : null), { timeoutMs: 5000, intervalMs: 50, label: 'zombie child pid' })
    const zombiePid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    process.kill(zombiePid, 'SIGKILL')
    await waitFor(
      () => (fs.existsSync(`/proc/${zombiePid}/stat`) && fs.readFileSync(`/proc/${zombiePid}/stat`, 'utf8').slice(fs.readFileSync(`/proc/${zombiePid}/stat`, 'utf8').lastIndexOf(')') + 2, fs.readFileSync(`/proc/${zombiePid}/stat`, 'utf8').lastIndexOf(')') + 3) === 'Z' ? true : null),
      { timeoutMs: 5000, intervalMs: 50, label: 'zombie state' },
    )
    fs.writeFileSync(
      path.join(dir, 'pid.json'),
      JSON.stringify({ pid: zombiePid, startedAt: Date.now(), profile: 'web', port, protocol: 'http:', version: '0.1.0', argv: [], sessionId: '' }),
    )

    const state = await waitFor(
      () => {
        const value = readJson(path.join(dir, 'state.json'), null)
        if (!value || value.phase !== 'monitoring' || !value.health?.ok) return null
        if (!Array.isArray(value.restarts) || value.restarts.length < 1) return null
        return value
      },
      { timeoutMs: 30000, intervalMs: 250, label: 'recovery from a zombie host' },
    )
    assert.equal(state.incident, null)
    assert.ok(findPidsByPort(port).pids.length > 0, 'a fresh server listens again')
    assert.equal(fs.existsSync(path.join(dir, 'ALERT.md')), false)
    const log = fs.readFileSync(path.join(dir, 'restart-guard.log'), 'utf8')
    assert.doesNotMatch(log, /refusing to kill pid \d+: \[MainThread\]/, 'the zombie is never "killed"')
    assert.match(log, /kill-stale-skipped|stale-pid/) 
  } finally {
    watcher.kill('SIGKILL')
    keeper.kill('SIGKILL')
    for (const pid of findPidsByPort(port).pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
