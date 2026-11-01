// @ts-check
/**
 * The drill the settings page offers must actually recover: the guard kills
 * the host on purpose, recognises the stop as its own, and starts a fresh
 * server without waiting for a stalled timeout.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { saveConfig } from '../../lib/shared/config.js'
import { instanceDir, readJson } from '../../lib/shared/paths.js'
import { findPidsByPort, pidAlive } from '../../lib/shared/probe.js'
import { fakeTree, freePort, profileDir, tmpHome, waitFor, writeFakeLaunch } from '../helpers.mjs'

const watcherPath = path.join(import.meta.dirname, '..', '..', 'lib', 'watcher.mjs')

test('simulate-crash recovers without a stalled incident', { timeout: 60000 }, async (t) => {
  const home = tmpHome()
  const port = await freePort(4030)
  const logPath = path.join(home, 'boot.log')
  const env = { DSH_HOME: home }
  const dir = instanceDir(env, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  profileDir(home, 'web')
  const tree = fakeTree(home)
  writeFakeLaunch(dir, { port, logPath, mode: 'ok', binPath: tree.binPath, pkgRoot: tree.pkgRoot })
  saveConfig(
    {
      watchdog: {
        probeIntervalMs: 500,
        probeTimeoutMs: 1000,
        startupGraceMs: 1000,
        stalledExitMs: 4000,
        bootTimeoutMs: 10000,
        settleMs: 200,
        maxRestartAttempts: 2,
      },
      maintenance: { autoDetect: false },
      supervision: { mode: 'none' },
      security: { dangerousActions: true },
      logs: { bootLogPath: logPath },
      notify: { command: { enabled: false, program: '', args: [] } },
    },
    { env },
  )

  const host = spawn(process.execPath, [tree.binPath, 'web', '--port', String(port)], {
    env: { ...process.env, ...env, FAKE_DSH_MODE: 'ok' },
    stdio: 'ignore',
  })
  const watcher = spawn(
    process.execPath,
    [watcherPath, '--home', home, '--profile', 'web', '--port', String(port), '--instance', dir],
    { env: { ...process.env, ...env }, stdio: 'inherit' },
  )
  try {
    await waitFor(() => (findPidsByPort(port).pids.length > 0 ? true : null), { timeoutMs: 8000, intervalMs: 100, label: 'host listening' })
    fs.writeFileSync(
      path.join(dir, 'pid.json'),
      JSON.stringify({ pid: host.pid, startedAt: Date.now(), profile: 'web', port, protocol: 'http:', version: '0.1.0', argv: [], sessionId: '' }),
    )
    await waitFor(
      () => {
        const state = readJson(path.join(dir, 'state.json'), null)
        return state && state.phase === 'monitoring' && state.health?.ok ? state : null
      },
      { timeoutMs: 15000, intervalMs: 200, label: 'watcher monitoring' },
    )

    fs.mkdirSync(path.join(dir, 'control', 'requests'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'control', 'requests', `${Date.now()}-drill.json`), JSON.stringify({ action: 'simulate-crash' }))

    const recovered = await waitFor(
      () => {
        const state = readJson(path.join(dir, 'state.json'), null)
        if (!state) return null
        const holder = findPidsByPort(port).pids[0] ?? 0
        if (state.phase !== 'monitoring' || !state.health?.ok) return null
        if (holder <= 0 || holder === host.pid) return null
        if (!Array.isArray(state.restarts) || state.restarts.length < 1) return null
        return { state, holder }
      },
      { timeoutMs: 30000, intervalMs: 250, label: 'recovery after the drill' },
    )
    assert.equal(recovered.state.incident, null, 'the incident is resolved')
    if (fs.existsSync(path.join(dir, 'ALERT.md'))) {
      t.diagnostic(fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8'))
      t.diagnostic(fs.readFileSync(path.join(dir, 'restart-guard.log'), 'utf8').split('\n').slice(-40).join('\n'))
    }
    assert.equal(fs.existsSync(path.join(dir, 'ALERT.md')), false, 'no alert for a successful drill')
    const incidents = fs.existsSync(path.join(dir, 'incidents')) ? fs.readdirSync(path.join(dir, 'incidents')) : []
    assert.deepEqual(incidents.filter((name) => /stalled/.test(name)), [], 'the kill is not reported as stalled')
    const log = fs.readFileSync(path.join(dir, 'restart-guard.log'), 'utf8')
    assert.match(log, /expected-stop/, 'the planned stop is recognised as the guard\'s own')
    assert.doesNotMatch(log, /repair-failed/, 'the repair ladder does not fail')
  } finally {
    watcher.kill('SIGKILL')
    host.kill('SIGKILL')
    for (const pid of findPidsByPort(port).pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    void t
  }
})
