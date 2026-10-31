// @ts-check
/**
 * A host that accepts TCP but answers too slowly is not down.
 *
 * Restarting it would kill a healthy server exactly when it is busy (plugin
 * start-up, a large render). The watcher must keep monitoring instead of
 * spawning a competing process.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { saveConfig } from '../../lib/shared/config.js'
import { instanceDir, readJson } from '../../lib/shared/paths.js'
import { findPidsByPort } from '../../lib/shared/probe.js'
import { fakeTree, freePort, profileDir, tmpHome, waitFor, writeFakeLaunch } from '../helpers.mjs'

const watcherPath = path.join(import.meta.dirname, '..', '..', 'lib', 'watcher.mjs')

test('a slow but listening host is not restarted', { timeout: 60000 }, async (t) => {
  const home = tmpHome()
  const port = freePort(3955)
  const logPath = path.join(home, 'boot.log')
  const env = { DSH_HOME: home }
  const dir = instanceDir(env, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  profileDir(home, 'web')
  const tree = fakeTree(home)
  writeFakeLaunch(dir, { port, logPath, mode: 'hang', binPath: tree.binPath, pkgRoot: tree.pkgRoot })
  saveConfig(
    {
      watchdog: { probeIntervalMs: 500, probeTimeoutMs: 250, startupGraceMs: 1000, bootTimeoutMs: 5000, settleMs: 200, maxRestartAttempts: 2 },
      maintenance: { autoDetect: false },
    },
    { env },
  )

  // The hung server is the "running" DSH: start it, then the watcher.
  const host = spawn(process.execPath, [tree.binPath, 'web', '--port', String(port)], {
    env: { ...process.env, ...env, FAKE_DSH_MODE: 'hang' },
    stdio: 'ignore',
  })
  const started = Date.now()
  while (Date.now() - started < 5000) {
    if (findPidsByPort(port).pids.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  fs.writeFileSync(
    path.join(dir, 'pid.json'),
    JSON.stringify({ pid: host.pid, startedAt: Date.now(), profile: 'web', port, protocol: 'http:', version: '0.1.0', argv: [], sessionId: '' }),
  )

  const watcher = spawn(process.execPath, [watcherPath, '--home', home, '--profile', 'web', '--port', String(port), '--instance', dir], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  })
  /** @type {number[]} */
  let holders = []
  try {
    void host
    const stateFile = path.join(dir, 'state.json')
    const state = await waitFor(
      () => {
        const value = readJson(stateFile, null)
        return value && value.phase === 'monitoring' && value.health?.error === 'slow' ? value : null
      },
      { timeoutMs: 15000, intervalMs: 200, label: 'slow probe observed' },
    )
    assert.equal(state.phase, 'monitoring')
    assert.equal((state.restarts ?? []).length, 0, 'no restart for a slow host')
    assert.equal(fs.existsSync(path.join(dir, 'ALERT.md')), false)
    const incidents = fs.existsSync(path.join(dir, 'incidents')) ? fs.readdirSync(path.join(dir, 'incidents')) : []
    assert.deepEqual(incidents, [], 'no incident recorded for a slow host')
    holders = findPidsByPort(port).pids
    assert.deepEqual(holders, [host.pid], 'the hung server is still the only holder')
    assert.equal(watcher.exitCode, null, 'the watcher is still running')
  } finally {
    watcher.kill('SIGKILL')
    host.kill('SIGKILL')
    for (const pid of holders) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    void t
  }
})
