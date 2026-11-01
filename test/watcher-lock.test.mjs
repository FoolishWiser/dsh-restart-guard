// @ts-check
/**
 * Exactly one watcher may run per instance. The predecessor is asked to stand
 * down through a pid-addressed stop control, and the successor must not clear
 * that stop before the predecessor reads it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { saveConfig } from '../lib/shared/config.js'
import { instanceDir, readJson, writeJsonAtomic } from '../lib/shared/paths.js'
import { pidAlive } from '../lib/shared/probe.js'
import { fakeTree, freePort, profileDir, tmpHome, waitFor, writeFakeLaunch } from './helpers.mjs'

const watcherPath = path.join(import.meta.dirname, '..', 'lib', 'watcher.mjs')

/** @param {{ home: string, dir: string, port: number }} input */
function startWatcher({ home, dir, port }) {
  const env = { ...process.env, DSH_HOME: home }
  for (const key of ['INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'NOTIFY_SOCKET', 'PM2_HOME', 'pm_id', 'pm_exec_path']) delete env[key]
  return spawn(
    process.execPath,
    [watcherPath, '--home', home, '--profile', 'web', '--port', String(port), '--instance', dir],
    { env, stdio: 'ignore' },
  )
}

test('two watchers started together leave exactly one running', { timeout: 30000 }, async () => {
  const home = tmpHome()
  const port = await freePort(3990)
  const env = { DSH_HOME: home }
  const dir = instanceDir(env, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  profileDir(home, 'web')
  const tree = fakeTree(home)
  writeFakeLaunch(dir, { port, logPath: path.join(home, 'boot.log'), mode: 'ok', binPath: tree.binPath, pkgRoot: tree.pkgRoot })
  saveConfig({ watchdog: { probeIntervalMs: 500 }, maintenance: { autoDetect: false }, supervision: { mode: 'none' } }, { env })

  const first = startWatcher({ home, dir, port })
  const second = startWatcher({ home, dir, port })
  try {
    const lock = await waitFor(
      () => {
        const value = readJson(path.join(dir, 'watcher.lock'), null)
        const tree2 = readJson(path.join(dir, 'watcher.json'), null)
        return value && tree2 && Number(value.pid) === Number(tree2.pid) ? value : null
      },
      { timeoutMs: 15000, intervalMs: 200, label: 'a single lock owner' },
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const owners = [first.pid, second.pid].filter((pid) => pid && pidAlive(pid))
    assert.equal(owners.length, 1, `expected one watcher, saw ${owners.join(',')}`)
    assert.equal(Number(lock.pid), owners[0], 'the lock names the surviving watcher')
    const log = fs.readFileSync(path.join(dir, 'restart-guard.log'), 'utf8')
    assert.match(log, /another watcher is active|lock-lost|lock-replace/, 'the loser says why it left')
  } finally {
    first.kill('SIGKILL')
    second.kill('SIGKILL')
  }
})

test('a stop control only stops the watcher it names', { timeout: 30000 }, async () => {
  const home = tmpHome()
  const port = await freePort(4010)
  const env = { DSH_HOME: home }
  const dir = instanceDir(env, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  profileDir(home, 'web')
  const tree = fakeTree(home)
  writeFakeLaunch(dir, { port, logPath: path.join(home, 'boot.log'), mode: 'ok', binPath: tree.binPath, pkgRoot: tree.pkgRoot })
  saveConfig({ watchdog: { probeIntervalMs: 500 }, maintenance: { autoDetect: false }, supervision: { mode: 'none' } }, { env })

  const watcher = startWatcher({ home, dir, port })
  try {
    await waitFor(() => (readJson(path.join(dir, 'watcher.json'), null) ? true : null), { timeoutMs: 10000, intervalMs: 100, label: 'watcher start' })
    writeJsonAtomic(path.join(dir, 'control', 'stop.json'), { ts: Date.now(), targetPid: 999_999, reason: 'not me' })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(pidAlive(watcher.pid), true, 'a stop for another pid is ignored')

    writeJsonAtomic(path.join(dir, 'control', 'stop.json'), { ts: Date.now(), targetPid: watcher.pid, reason: 'operator request' })
    await waitFor(() => (pidAlive(watcher.pid) ? null : true), { timeoutMs: 8000, intervalMs: 100, label: 'targeted stop' })
    assert.equal(pidAlive(watcher.pid), false, 'the addressed watcher exits')
    assert.equal(fs.existsSync(path.join(dir, 'control', 'stop.json')), false, 'it clears its own stop on the way out')
  } finally {
    watcher.kill('SIGKILL')
  }
})
