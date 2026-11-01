// @ts-check
/**
 * A third-party plugin that aborts startup: the guard must notice that the
 * 401 on the port is not a healthy boot (dsh prints a StartupError and stays
 * up), hand the failing package to the AI, apply the bounded file edit and
 * start DSH again.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { saveConfig } from '../../lib/shared/config.js'
import { readJson } from '../../lib/shared/paths.js'
import { fakeTree, freePort, profileDir, tmpHome, waitFor, writeFakeLaunch } from '../helpers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const watcherPath = path.join(root, 'lib', 'watcher.mjs')
const stubAi = path.join(root, 'demo', 'stub-ai.mjs')

test('a broken third-party plugin is diagnosed, AI-edited and booted again', async (t) => {
  const home = tmpHome()
  const port = await freePort(3970)
  const dir = path.join(home, 'restart-guard', 'instances', `web-${port}`)
  const logPath = path.join(home, 'boot.log')
  profileDir(home, 'web')

  // A real third-party package: its apply() throws until demo-config is enabled.
  const pkgDir = path.join(home, 'plugins', 'dsh-demo-broken')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-demo-broken', version: '0.0.0-demo', type: 'module', main: 'index.js' }, null, 2) + '\n')
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'export function apply() {}\n')
  const configPath = path.join(pkgDir, 'demo-config.json')
  fs.writeFileSync(configPath, '{\n  "enabled": false\n}\n')
  fs.mkdirSync(path.join(home, 'profiles', 'web', 'node_modules'), { recursive: true })
  fs.symlinkSync(pkgDir, path.join(home, 'profiles', 'web', 'node_modules', 'dsh-demo-broken'), 'dir')

  const base = path.join(home, 'fake-dsh-root')
  fs.mkdirSync(base, { recursive: true })
  const tree = fakeTree(base)
  writeFakeLaunch(dir, {
    port,
    logPath,
    mode: 'plugin-broken',
    binPath: tree.binPath,
    pkgRoot: tree.pkgRoot,
    env: { FAKE_DSH_CONFIG: configPath, FAKE_DSH_PKG: 'dsh-demo-broken' },
  })

  saveConfig(
    {
      watchdog: {
        probeIntervalMs: 500,
        startupGraceMs: 1000,
        bootTimeoutMs: 15000,
        settleMs: 200,
        stalledExitMs: 5000,
        maxRestartAttempts: 2,
        crashLoop: { windowMs: 60000, maxIncidents: 5, pauseMs: 60000 },
      },
      readiness: { inferredSettleMs: 1500, inferredQuietMs: 500 },
      maintenance: { autoDetect: false },
      supervision: { mode: 'none' },
      logs: { bootLogPath: logPath },
      ai: {
        enabled: true,
        mode: 'act',
        order: 'direct-only',
        credentialSource: 'none',
        bridge: { enabled: true, program: process.execPath, args: [stubAi] },
      },
    },
    { env: { DSH_HOME: home } },
  )

  const childEnv = { ...process.env, DSH_HOME: home }
  for (const key of ['INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'NOTIFY_SOCKET', 'PM2_HOME', 'pm_id', 'pm_exec_path']) {
    delete childEnv[key]
  }
  const watcher = spawn(process.execPath, [watcherPath, '--home', home, '--profile', 'web', '--port', String(port), '--instance', dir], {
    env: childEnv,
    stdio: 'ignore',
  })
  try {
    const state = await waitFor(
      () => {
        const current = readJson(path.join(dir, 'state.json'), null)
        if (current?.phase === 'monitoring' && current?.repair && current?.health?.ok) return current
        return null
      },
      { timeoutMs: 45000, intervalMs: 200, label: 'AI repair to finish' },
    )
    const repairedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(repairedConfig.enabled, true)
    assert.equal(state.repair.kind, 'fix-plugin')
    assert.equal(state.repair.entryName, 'dsh-demo-broken')
    assert.equal(state.repair.changed[0].file, 'demo-config.json')
    assert.ok(fs.existsSync(state.repair.changed[0].backup), 'the original file is backed up')

    const log = fs.readFileSync(path.join(dir, 'restart-guard.log'), 'utf8')
    assert.match(log, /boot-kill stopped the half-started boot/)
    assert.match(log, /ai-fixed bridge: dsh-demo-broken/)
  } catch (error) {
    const state = readJson(path.join(dir, 'state.json'), null)
    t.diagnostic(`state: ${JSON.stringify(state, null, 1)}`)
    try {
      t.diagnostic(`log: ${fs.readFileSync(path.join(dir, 'restart-guard.log'), 'utf8').split('\n').slice(-40).join('\n')}`)
    } catch {
      /* ignore */
    }
    throw error
  } finally {
    watcher.kill('SIGKILL')
  }
})
