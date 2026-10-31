// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS } from '../lib/shared/config.js'
import { nextStep, planRepairSteps, planSummary } from '../lib/shared/plan.js'

const diagnosis = (incident) => ({ incident, detail: `${incident} detail`, evidence: ['line'], unresolved: [], inactive: [] })
const maintenance = (patch = {}) => (/** @type {any} */ ({ active: false, signal: '', signals: [], until: 0, treeIntact: true, terminal: 'unknown', treeVersion: '', upgradeDir: null, restarters: [], ...patch }))
const supervisor = { kind: 'none', detail: 'no supervisor', mayAct: true }
const occupant = { pids: [], isDsh: false, cmdline: '' }
const config = DEFAULTS

/** @param {Partial<Parameters<typeof planRepairSteps>[0]>} patch */
const plan = (patch = {}) =>
  planRepairSteps({
    diagnosis: diagnosis('crash'),
    attempt: 1,
    config,
    maintenance: maintenance(),
    supervisor,
    occupant,
    port: 3079,
    ...patch,
  })

test('maintenance holds: no spawn, no rollback, no kill', () => {
  const result = plan({
    diagnosis: diagnosis('yaml-config'),
    maintenance: maintenance({ active: true, signal: 'tree', signals: ['upgrade dir'] }),
  })
  assert.equal(result.stopReason, 'maintenance')
  const actions = result.steps.map((step) => step.action)
  assert.deepEqual(actions, ['hold', 'notify'])
  assert.equal(actions.includes('start-dsh'), false)
  assert.equal(actions.includes('rollback-patch'), false)
})

test('an incomplete package tree is never started', () => {
  const result = plan({ maintenance: maintenance({ treeIntact: false }) })
  assert.equal(result.stopReason, 'tree-incomplete')
  assert.deepEqual(result.steps.map((step) => step.action), ['manual', 'notify'])
})

test('supervised deployments are notified, not fought', () => {
  const result = plan({ supervisor: { kind: 'systemd', detail: 'JOURNAL_STREAM' } })
  assert.equal(result.stopReason, 'supervised')
  assert.deepEqual(result.steps.map((step) => step.action), ['hold', 'notify'])
})

test('a container without a supervisor is allowed to act', () => {
  const result = plan({
    supervisor: { kind: 'docker-no-init', detail: 'PID 1 is not an init', mayAct: true },
  })
  assert.equal(result.stopReason, '')
  assert.deepEqual(result.steps.map((step) => step.action), ['start-dsh', 'verify'])
})

test('a YAML failure rolls the patch back on the first attempt', () => {
  const result = plan({ diagnosis: diagnosis('yaml-config') })
  assert.equal(result.stopReason, '')
  assert.deepEqual(result.steps.map((step) => step.action), ['rollback-patch', 'start-dsh', 'verify', 'notify'])
  assert.ok(nextStep(result, 'rollback-patch'))
  assert.ok(nextStep(result, 'start-dsh'))
})

test('the patch rollback is tried once, not on every attempt', () => {
  const result = plan({ diagnosis: diagnosis('patch-incompatible'), attempt: 2 })
  const actions = result.steps.map((step) => step.action)
  assert.equal(actions.includes('rollback-patch'), false)
  assert.deepEqual(actions, ['start-dsh', 'verify', 'notify'])
})

test('a foreign port holder is reported, never killed', () => {
  const result = plan({
    diagnosis: diagnosis('port-in-use'),
    occupant: { pids: [4242], isDsh: false, cmdline: 'nginx' },
  })
  assert.equal(result.stopReason, 'foreign-holder')
  const actions = result.steps.map((step) => step.action)
  assert.equal(actions.includes('kill-stale'), false)
  assert.equal(actions.includes('start-dsh'), false)
  assert.deepEqual(actions, ['manual', 'notify'])
})

test('a stale DSH holder is only killed when the operator opted in', () => {
  const occupantDsh = { pids: [4242], isDsh: true, cmdline: 'dsh web --port 3079' }
  const optOut = plan({ diagnosis: diagnosis('port-in-use'), occupant: occupantDsh })
  assert.equal(optOut.stopReason, 'foreign-holder')
  const config = { ...DEFAULTS, watchdog: { ...DEFAULTS.watchdog, killStaleDshHolder: true } }
  const optIn = planRepairSteps({
    diagnosis: diagnosis('port-in-use'),
    attempt: 1,
    config,
    maintenance: maintenance(),
    supervisor,
    occupant: occupantDsh,
    port: 3079,
  })
  assert.equal(optIn.stopReason, '')
  assert.deepEqual(optIn.steps.map((step) => step.action), ['kill-stale', 'start-dsh', 'verify'])
})

test('a stalled process is killed and restarted', () => {
  const result = plan({ diagnosis: diagnosis('stalled') })
  assert.deepEqual(result.steps.map((step) => step.action), ['kill-stale', 'start-dsh', 'verify'])
})

test('operator-fix incidents do not spawn', () => {
  for (const incident of ['wildcard-host', 'module-missing', 'permission-disk-memory']) {
    const result = plan({ diagnosis: diagnosis(incident) })
    assert.equal(result.stopReason, 'needs-operator', incident)
    const actions = result.steps.map((step) => step.action)
    assert.equal(actions.includes('start-dsh'), false, incident)
    assert.deepEqual(actions, ['manual', 'notify'], incident)
  }
})

test('the restart budget stops the guard', () => {
  const result = plan({ attempt: 3 })
  assert.equal(result.stopReason, 'attempts-exhausted')
  assert.deepEqual(result.steps.map((step) => step.action), ['manual', 'notify'])
})

test('a plain crash starts and verifies', () => {
  const result = plan({ diagnosis: diagnosis('crash') })
  assert.equal(result.stopReason, '')
  assert.deepEqual(result.steps.map((step) => step.action), ['start-dsh', 'verify'])
})

test('planSummary is a one-liner', () => {
  const result = plan({ diagnosis: diagnosis('crash') })
  const summary = planSummary(result)
  assert.equal(summary, 'start-dsh:pending -> verify:pending')
})
