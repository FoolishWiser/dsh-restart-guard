// @ts-check
/**
 * An authentication gateway in front of the DSH webserver is healthy.
 *
 * The entry port answers 302 (login page) and the real DSH core sits two ports
 * higher on loopback. The watcher must report `kind:'gateway'` instead of
 * treating the login page as a foreign listener, and it must not restart the
 * host. When the gateway wedges (accepts TCP, never answers) it also must not
 * spawn a competing process.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { saveConfig } from '../../lib/shared/config.js'
import { instanceDir, readJson } from '../../lib/shared/paths.js'
import { findPidsByPort } from '../../lib/shared/probe.js'
import { profileDir, tmpHome, waitFor, writeFakeLaunch } from '../helpers.mjs'

const watcherPath = path.join(import.meta.dirname, '..', '..', 'lib', 'watcher.mjs')
const AUTH_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.'

/**
 * @param {number} status
 * @param {string} body
 * @param {Record<string, string>} [headers]
 */
function listen(status, body, headers = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain', ...headers })
      res.end(body)
    })
    srv.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (srv.address())
      resolve({ srv, port: address.port })
    })
  })
}

/** @param {number} port */
function wedgedServer(port) {
  return new Promise((resolve) => {
    const srv = net.createServer(() => {
      /* accept the socket and never answer */
    })
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

test('a gateway front end is healthy and never restarted', { timeout: 60000 }, async (t) => {
  const home = tmpHome()
  const env = { DSH_HOME: home }
  profileDir(home, 'web')

  // Find a base port and pin the stack: gateway at base, DSH core at base + 2.
  let base = 0
  let core = /** @type {Awaited<ReturnType<typeof listen>> | null} */ (null)
  let gateway = /** @type {Awaited<ReturnType<typeof listen>> | null} */ (null)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 4800 + Math.floor(Math.random() * 400)
    try {
      core = await listen(401, AUTH_BODY)
      const corePort = core.port
      if (corePort < 3) throw new Error('port too low')
      base = corePort - 2
      gateway = await new Promise((resolve, reject) => {
        const srv = http.createServer((req, res) => {
          res.writeHead(302, { location: '/login' })
          res.end()
        })
        srv.once('error', reject)
        srv.listen(base, '127.0.0.1', () => resolve({ srv, port: base }))
      })
      break
    } catch {
      core?.srv.close()
      core = null
      gateway = null
      base = 0
    }
  }
  assert.ok(core && gateway && base > 0, 'could not reserve a gateway/core port pair')

  const port = base
  const logPath = path.join(home, 'boot.log')
  const dir = instanceDir(env, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  writeFakeLaunch(dir, { port, logPath, mode: 'ok' })
  saveConfig(
    {
      watchdog: {
        probeIntervalMs: 400,
        probeTimeoutMs: 500,
        startupGraceMs: 500,
        bootTimeoutMs: 5000,
        settleMs: 100,
        maxRestartAttempts: 1,
        stalledExitMs: 60000,
      },
      maintenance: { autoDetect: false },
      supervision: { mode: 'none' },
      notify: { webhook: { enabled: false }, command: { enabled: false }, im: { enabled: false } },
    },
    { env },
  )

  // A live process stands in for the DSH host.
  const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  fs.writeFileSync(
    path.join(dir, 'pid.json'),
    JSON.stringify({ pid: host.pid, startedAt: Date.now(), profile: 'web', port, protocol: 'http:', version: '0.1.9', argv: [], sessionId: '' }),
  )

  const watcher = spawn(process.execPath, [watcherPath, '--home', home, '--profile', 'web', '--port', String(port), '--instance', dir], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  })

  /** @type {import('node:net').Server | null} */
  let wedged = null
  try {
    const stateFile = path.join(dir, 'state.json')
    const healthy = await waitFor(
      () => {
        const value = readJson(stateFile, null)
        return value && value.phase === 'monitoring' && value.health?.kind === 'gateway' ? value : null
      },
      { timeoutMs: 20000, intervalMs: 200, label: 'gateway detected as healthy' },
    )
    assert.equal(healthy.health.corePort, core.port, 'the core port is reported')
    assert.equal((healthy.restarts ?? []).length, 0, 'no restart for a healthy gateway')
    assert.equal(fs.existsSync(path.join(dir, 'ALERT.md')), false)
    const incidentsDir = path.join(dir, 'incidents')
    const incidents = fs.existsSync(incidentsDir) ? fs.readdirSync(incidentsDir) : []
    assert.deepEqual(incidents, [])
    assert.ok(findPidsByPort(port).pids.includes(process.pid), 'the gateway in this test holds the entry port')

    // The gateway now accepts TCP and never answers: a wedge, not a crash.
    await new Promise((resolve) => gateway.srv.close(resolve))
    gateway = null
    wedged = await wedgedServer(port)
    const wedgedState = await waitFor(
      () => {
        const value = readJson(stateFile, null)
        return value && value.health?.error && ['slow', 'listening'].includes(value.health.error) ? value : null
      },
      { timeoutMs: 20000, intervalMs: 200, label: 'wedged gateway observed' },
    )
    assert.equal(wedgedState.phase, 'monitoring')
    assert.equal((wedgedState.restarts ?? []).length, 0, 'a wedged gateway must not be restarted')
    assert.equal(host.exitCode, null, 'the host process is untouched')
    assert.equal(fs.existsSync(path.join(dir, 'ALERT.md')), false)
  } finally {
    watcher.kill('SIGKILL')
    host.kill('SIGKILL')
    wedged?.close()
    gateway?.srv.close()
    core.srv.close()
  }
})
