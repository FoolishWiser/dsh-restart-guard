// @ts-check
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readControl, writeControl } from '../../lib/shared/state.js'
import { instanceDir, readJson } from '../../lib/shared/paths.js'
import { pidAlive } from '../../lib/shared/probe.js'
import { freePort, profileDir, tmpHome, waitFor } from '../helpers.mjs'

const watcherPath = fileURLToPath(new URL('../../lib/watcher.mjs', import.meta.url))

/**
 * @param {string} home
 * @param {string} dir
 * @param {number} port
 * @param {boolean} replace
 */
function startWatcher(home, dir, port, replace) {
  const env = { ...process.env, DSH_HOME: home }
  for (const key of ['INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'NOTIFY_SOCKET', 'PM2_HOME', 'pm_id']) {
    delete env[key]
  }
  const args = [watcherPath, '--home', home, '--profile', 'web', '--port', String(port), '--instance', dir]
  if (replace) args.push('--replace')
  const child = spawn(process.execPath, args, { env, stdio: 'ignore' })
  return child
}

test('a handing-over watcher clears the stop control it was asked to honour', { timeout: 45000 }, async (t) => {
  const home = tmpHome()
  profileDir(home, 'web')
  const port = await freePort(3970)
  const dir = instanceDir({ DSH_HOME: home }, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(home, 'restart-guard'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'restart-guard', 'config.json'),
    JSON.stringify({
      watchdog: { probeIntervalMs: 200, startupGraceMs: 60000, settleMs: 0 },
      maintenance: { autoDetect: false },
      supervision: { mode: 'none' },
      logs: { bootLogPath: path.join(home, 'boot.log') },
    }),
  )

  const lockPath = path.join(dir, 'watcher.lock')
  const first = startWatcher(home, dir, port, false)
  t.after(() => {
    if (pidAlive(first.pid ?? 0)) first.kill('SIGKILL')
  })
  await waitFor(() => Number(readJson(lockPath, null)?.pid) === first.pid, { timeoutMs: 20000, label: 'first watcher holds the lock' })

  const second = startWatcher(home, dir, port, true)
  t.after(() => {
    writeControl(dir, 'stop', { ts: Date.now(), reason: 'test complete' })
    if (pidAlive(second.pid ?? 0)) second.kill('SIGKILL')
  })
  await waitFor(() => Number(readJson(lockPath, null)?.pid) === second.pid, { timeoutMs: 30000, label: 'second watcher takes the lock' })
  await waitFor(() => !pidAlive(first.pid ?? 0), { timeoutMs: 20000, label: 'predecessor exits' })

  assert.equal(readControl(dir, 'stop'), null, 'the handover stop control is cleared, so the successor keeps running')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(pidAlive(second.pid ?? 0), true, 'successor is still alive after its first loop iterations')
})
