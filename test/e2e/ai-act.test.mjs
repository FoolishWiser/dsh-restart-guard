// @ts-check
/**
 * AI repair in act mode: when the DSH-agent channel is enabled and succeeds,
 * the guard reports the port as repaired by the AI and never runs the rule ladder.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { saveConfig } from '../../lib/shared/config.js'
import { instanceDir, readJson } from '../../lib/shared/paths.js'
import { findPidsByPort } from '../../lib/shared/probe.js'
import { fakeTree, freePort, profileDir, tmpHome, waitFor, writeFakeLaunch } from '../helpers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const watcherPath = path.join(root, 'lib', 'watcher.mjs')
const agentPath = path.join(root, 'test', 'fixtures', 'fake-repair-agent.mjs')

test('an AI repair that works is reported as such, without the rule ladder', { timeout: 90000 }, async (t) => {
  const home = tmpHome()
  const port = await freePort(3970)
  const logPath = path.join(home, 'boot.log')
  const dir = instanceDir({ DSH_HOME: home }, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  profileDir(home, 'web')
  const tree = fakeTree(home)
  // The real `dsh` takes `--profile` before its subcommand; a node stand-in
  // would choke on that flag, so the agent is reached through a tiny wrapper.
  const agentWrapper = path.join(home, 'agent.sh')
  fs.writeFileSync(agentWrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(agentPath)} "$@"\n`, { mode: 0o755 })
  writeFakeLaunch(dir, { port, logPath, mode: 'ok', binPath: tree.binPath, pkgRoot: tree.pkgRoot })

  saveConfig(
    {
      watchdog: {
        probeIntervalMs: 500,
        startupGraceMs: 1000,
        bootTimeoutMs: 15000,
        settleMs: 200,
        stalledExitMs: 5000,
        maxRestartAttempts: 0,
        crashLoop: { windowMs: 60000, maxIncidents: 3, pauseMs: 60000 },
      },
      maintenance: { autoDetect: false },
      supervision: { mode: 'none' },
      logs: { bootLogPath: logPath },
      ai: {
        enabled: true,
        mode: 'act',
        order: 'dsh-agent-only',
        dshAgent: { enabled: true, command: agentWrapper, args: [], timeoutMs: 30000 },
      },
    },
    { env: { DSH_HOME: home } },
  )

  const childEnv = { ...process.env, DSH_HOME: home, FAKE_DSH_BIN: tree.binPath, FAKE_DSH_PORT: String(port), FAKE_DSH_LOG: logPath }
  for (const key of ['INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'NOTIFY_SOCKET', 'PM2_HOME', 'pm_id']) delete childEnv[key]
  const watcher = spawn(process.execPath, [watcherPath, '--home', home, '--profile', 'web', '--port', String(port), '--instance', dir], {
    env: childEnv,
    stdio: 'ignore',
  })

  t.after(() => {
    watcher.kill('SIGKILL')
    for (const pid of findPidsByPort(port).pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
    }
  })

  try {
    await waitFor(
      () => {
        const state = readJson(path.join(dir, 'state.json'), null) ?? {}
        return state.health?.ok === true && state.ai?.via === 'dsh-agent'
      },
      { timeoutMs: 60000, intervalMs: 250, label: 'AI repair' },
    )
  } catch (error) {
    t.diagnostic(JSON.stringify(readJson(path.join(dir, 'state.json'), null), null, 1))
    t.diagnostic(fs.readFileSync(path.join(dir, 'restart-guard.log'), 'utf8').split('\n').slice(-40).join('\n'))
    throw error
  }

  const state = readJson(path.join(dir, 'state.json'), null) ?? {}
  assert.equal(state.health.ok, true)
  assert.equal(state.ai.via, 'dsh-agent')
  assert.equal(state.ai.mode, 'act')
  assert.equal(state.incident, null, 'the incident is resolved by the AI')
  assert.equal((state.restarts ?? []).length, 0, 'the rule ladder never ran')
  assert.ok(findPidsByPort(port).pids.length > 0, 'something answers the port')
})
