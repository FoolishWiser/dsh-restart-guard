// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import { applySupervisorMode, detectSupervisor } from '../lib/shared/supervision.js'

test('systemd and pm2 environments are reported, not fought', () => {
  const systemd = detectSupervisor({ env: { INVOCATION_ID: 'abc' }, ppid: 1 })
  assert.equal(systemd.kind, 'systemd')
  assert.equal(systemd.mayAct, false)

  const journal = detectSupervisor({ env: { JOURNAL_STREAM: '8:1234' }, ppid: 1 })
  assert.equal(journal.kind, 'systemd')

  const pm2 = detectSupervisor({ env: { PM2_HOME: '/root/.pm2', pm_id: '2' }, ppid: 1 })
  assert.equal(pm2.kind, 'pm2')
  assert.equal(pm2.mayAct, false)
})

test('an ordinary parent means nobody else restarts DSH', () => {
  const info = detectSupervisor({ env: {}, ppid: process.ppid })
  // A plain process tree, or a container whose PID 1 does not restart DSH.
  assert.ok(['none', 'docker-no-init'].includes(info.kind), info.kind)
  assert.equal(info.mayAct, true)
})

test('supervision.mode can force either verdict', () => {
  /** @type {any} */
  const systemd = { kind: 'systemd', detail: 'unit', mayAct: false }
  /** @type {any} */
  const none = { kind: 'none', detail: 'parent', mayAct: true }

  const forced = applySupervisorMode(systemd, 'none')
  assert.equal(forced.kind, 'none')
  assert.equal(forced.mayAct, true)
  assert.match(forced.detail, /supervision\.mode=none/)
  assert.equal(applySupervisorMode(systemd, 'auto'), systemd, 'auto keeps the detection untouched')
  assert.equal(applySupervisorMode(none, 'auto'), none)

  const supervised = applySupervisorMode(none, 'supervised')
  assert.equal(supervised.mayAct, false)
  assert.match(supervised.detail, /supervision\.mode=supervised/)
})
