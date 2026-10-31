// @ts-check
/**
 * The watcher daemon end to end: it sees a dead port, starts the captured
 * command, verifies the boot, notifies, and then does it again after a hard
 * kill — while never starting anything during a maintenance window.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { saveConfig } from '../../lib/shared/config.js'
import { instanceDir, readJson, writeJsonAtomic } from '../../lib/shared/paths.js'
import { pidAlive } from '../../lib/shared/probe.js'
import { fakeTree, notifySink, profileDir, tmpHome, waitFor, writeFakeLaunch } from '../helpers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const watcherPath = path.join(root, 'lib', 'watcher.mjs')

/** @param {number} port @param {string} home @param {string} dir @param {string} sink */
function startWatcher(port, home, dir, sink) {
  saveConfig(
    {
      watchdog: {
        probeIntervalMs: 500,
        startupGraceMs: 1000,
        bootTimeoutMs: 10000,
        settleMs: 200,
        stalledExitMs: 5000,
        maxRestartAttempts: 2,
        crashLoop: { windowMs: 60000, maxIncidents: 3, pauseMs: 60000 },
      },
      maintenance: { autoDetect: false },
      notify: {
        command: { enabled: true, program: process.execPath, args: [notifySink, sink] },
      },
    },
    { env: { DSH_HOME: home } },
  )
  const child = spawn(
    process.execPath,
    [watcherPath, '--home', home, '--profile', 'web', '--port', String(port), '--instance', dir],
    { env: { ...process.env, DSH_HOME: home }, stdio: 'ignore' },
  )
  return child
}

/** @param {string} dir @returns {any} */
function stateOf(dir) {
  return readJson(path.join(dir, 'state.json'), null) ?? {}
}

test('the watcher repairs a dead port, again after kill -9, and stands down for maintenance', async (t) => {
  const home = tmpHome()
  const port = 3930 + Math.floor(Math.random() * 50)
  const logPath = path.join(home, 'boot.log')
  const sink = path.join(home, 'notify.log')
  const dir = instanceDir({ DSH_HOME: home }, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  profileDir(home, 'web')
  const tree = fakeTree(home)
  writeFakeLaunch(dir, { port, logPath, binPath: tree.binPath, pkgRoot: tree.pkgRoot })
  saveConfig({ logs: { bootLogPath: logPath } }, { env: { DSH_HOME: home } })

  const watcher = startWatcher(port, home, dir, sink)
  /** @type {Set<number>} */
  const spawned = new Set()
  t.after(() => {
    watcher.kill('SIGKILL')
    for (const pid of spawned) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
    }
  })

  await waitFor(
    () => {
      const state = stateOf(dir)
      const pid = Number(state.startedPid) || 0
      if (pid > 0 && pidAlive(pid)) spawned.add(pid)
      return state.phase === 'monitoring' && state.health?.ok === true && pidAlive(pid)
    },
    { timeoutMs: 30000, intervalMs: 250, label: 'first repair' },
  )
  const first = stateOf(dir)
  assert.equal(first.incident, null)
  const firstPid = Number(first.startedPid)
  assert.ok(firstPid > 0)
  assert.ok((first.restarts ?? []).length >= 1)

  await waitFor(
    () =>
      fs.existsSync(sink) &&
      /DSH (已恢复|is back)|Port \d+ answered again/.test(fs.readFileSync(sink, 'utf8')),
    { timeoutMs: 15000, label: 'repaired notification' },
  )

  // A hard kill must be repaired too.
  process.kill(firstPid, 'SIGKILL')
  await waitFor(
    () => {
      const state = stateOf(dir)
      const pid = Number(state.startedPid) || 0
      if (pid > 0) spawned.add(pid)
      return pid !== firstPid && pidAlive(pid) && state.phase === 'monitoring' && state.health?.ok === true
    },
    { timeoutMs: 30000, intervalMs: 250, label: 'second repair' },
  )

  const launch = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8'))
  assert.ok(!String(launch.argv[1]).endsWith('watcher.mjs'), 'the stored recipe must never be the watcher itself')

  // Maintenance window: kill the server and expect no new spawn.
  const secondPid = Number(stateOf(dir).startedPid)
  const restartsBefore = (stateOf(dir).restarts ?? []).length
  writeJsonAtomic(path.join(dir, 'control', 'maintenance.json'), {
    until: Date.now() + 60000,
    reason: 'upgrade drill',
  })
  process.kill(secondPid, 'SIGKILL')
  await waitFor(() => stateOf(dir).phase === 'maintenance', {
    timeoutMs: 15000,
    intervalMs: 200,
    label: 'maintenance phase',
  })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const during = stateOf(dir)
  assert.equal(during.phase, 'maintenance')
  assert.equal((during.restarts ?? []).length, restartsBefore, 'maintenance must not start a server')
  assert.equal(pidAlive(secondPid), false)

  const log = fs.readFileSync(path.join(dir, 'restart-guard.log'), 'utf8')
  assert.match(log, /host-change|monitoring|plan/)
})
