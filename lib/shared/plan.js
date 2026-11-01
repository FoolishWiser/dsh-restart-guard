// @ts-check
/**
 * Repair planning. Pure functions only: the watcher executes the steps, this
 * module decides what the ladder is for a given failure — and, just as
 * important, when the ladder must be empty.
 */

/** @typedef {'hold'|'notify'|'rollback-patch'|'kill-stale'|'start-dsh'|'verify'|'manual'} PlanAction */
/** @typedef {'pending'|'running'|'done'|'skipped'|'failed'} StepStatus */

/**
 * @typedef {{
 *   id: string,
 *   action: PlanAction,
 *   status: StepStatus,
 *   detail: string,
 *   startedAt?: number,
 *   finishedAt?: number,
 *   error?: string,
 * }} PlanStep
 */

/**
 * @typedef {{
 *   version: 1,
 *   incident: string,
 *   attempt: number,
 *   createdAt: number,
 *   stopReason: string,
 *   diagnosis: import('./diagnose.js').Diagnosis,
 *   steps: PlanStep[],
 *   ai?: Record<string, any>,
 * }} RepairPlan
 */

/**
 * @param {string} action
 * @param {string} detail
 * @returns {PlanStep}
 */
function step(action, detail) {
  return { id: `${action}-${Math.random().toString(36).slice(2, 8)}`, action: /** @type {PlanAction} */ (action), status: 'pending', detail }
}

/**
 * @param {{
 *   diagnosis: import('./diagnose.js').Diagnosis,
 *   attempt: number,
 *   config: import('./config.js').GuardConfig,
 *   maintenance: import('./maintenance.js').MaintenanceStatus,
 *   supervisor: { kind: string, detail: string, mayAct?: boolean },
 *   occupant: { pids: number[], isDsh: boolean, cmdline: string },
 *   port: number,
 * }} context
 * @returns {RepairPlan}
 */
export function planRepairSteps({ diagnosis, attempt, config, maintenance, supervisor, occupant, port }) {
  /** @type {PlanStep[]} */
  const steps = []
  let stopReason = ''

  if (maintenance.active) {
    stopReason = 'maintenance'
    steps.push(step('hold', `maintenance in progress (${maintenance.signal}): ${maintenance.signals.join('; ')}`))
    steps.push(step('notify', 'notify operator; the guard will not start, roll back or kill anything while maintenance is active'))
    return finish(diagnosis, attempt, stopReason, steps)
  }

  if (!maintenance.treeIntact) {
    stopReason = 'tree-incomplete'
    steps.push(step('manual', 'the DSH package tree is incomplete (package.json missing or unreadable) — refusing to start a server'))
    steps.push(step('notify', 'notify operator with the tree state; no spawn, no rollback'))
    return finish(diagnosis, attempt, stopReason, steps)
  }

  // A container without an init/supervisor (mayAct) still has nobody to restart
  // DSH, so the guard is allowed to act. Anything that *would* restart it
  // (systemd, pm2, supervisord, tini) is left alone.
  if (supervisor.kind !== 'none' && !supervisor.mayAct) {
    stopReason = 'supervised'
    steps.push(step('hold', `a supervisor (${supervisor.kind}) owns this process; the guard will not start a competing server`))
    steps.push(step('notify', 'notify operator with the failure and the log tail'))
    return finish(diagnosis, attempt, stopReason, steps)
  }

  const rollbackable = diagnosis.incident === 'yaml-config' || diagnosis.incident === 'patch-incompatible'
  if (rollbackable && config.watchdog.rollbackProfilePatch && attempt <= 1) {
    steps.push(step('rollback-patch', 'validate the most recent profile patch backup with --dump-config, then swap it in'))
  }

  if (diagnosis.incident === 'stalled') {
    steps.push(step('kill-stale', 'the DSH process is alive but the port has been unresponsive past stalledExitMs; stop it'))
    steps.push(step('start-dsh', 'start DSH again with the captured launch spec'))
    steps.push(step('verify', `wait for the access line and re-probe the port (${config.watchdog.bootTimeoutMs}ms)`))
    return finish(diagnosis, attempt, stopReason, steps)
  }

  if (diagnosis.incident === 'port-in-use') {
    if (occupant.isDsh && config.watchdog.killStaleDshHolder) {
      steps.push(step('kill-stale', `stop the stale DSH process holding the port: ${occupant.pids.join(',')}`))
      steps.push(step('start-dsh', 'start DSH again on the same port with the captured launch spec'))
      steps.push(step('verify', `wait for the access line and re-probe the port (${config.watchdog.bootTimeoutMs}ms)`))
      return finish(diagnosis, attempt, stopReason, steps)
    }
    stopReason = 'foreign-holder'
    steps.push(
      step('manual', `port ${port} is held by ${occupant.isDsh ? 'a DSH process' : 'a foreign process'} (pids ${occupant.pids.join(',') || 'unknown'}) — the guard does not kill it`),
    )
    steps.push(step('notify', 'notify operator with the holder pid/cmdline'))
    return finish(diagnosis, attempt, stopReason, steps)
  }

  const notRestartable = diagnosis.incident === 'wildcard-host' || diagnosis.incident === 'module-missing' || diagnosis.incident === 'permission-disk-memory'
  if (notRestartable) {
    stopReason = 'needs-operator'
    /** @type {Record<string, string>} */
    const hints = {
      'wildcard-host': 'bind a concrete address (--host 127.0.0.1) — DSH rejects 0.0.0.0',
      'module-missing': 'run `dsh plugin --profile <name> install` to rebuild the profile dependency tree',
      'permission-disk-memory': 'fix permissions / free disk space / raise the memory limit',
    }
    steps.push(step('manual', `${diagnosis.detail}: ${hints[diagnosis.incident]}`))
    steps.push(step('notify', 'notify operator with the diagnosis and the log tail'))
    return finish(diagnosis, attempt, stopReason, steps)
  }

  if (attempt > config.watchdog.maxRestartAttempts) {
    stopReason = 'attempts-exhausted'
    steps.push(step('manual', `restart budget exhausted (${config.watchdog.maxRestartAttempts}); not starting another server`))
    steps.push(step('notify', 'notify operator and stop the guard for this incident'))
    return finish(diagnosis, attempt, stopReason, steps)
  }

  steps.push(step('start-dsh', 'start DSH with the captured argv/env/cwd, appending to the boot log'))
  steps.push(step('verify', `wait for the access line and re-probe the port (${config.watchdog.bootTimeoutMs}ms)`))
  if (rollbackable && config.watchdog.rollbackProfilePatch) {
    steps.push(step('notify', 'notify operator: the patch rollback was already tried for this incident'))
  }
  return finish(diagnosis, attempt, stopReason, steps)
}

/**
 * @param {import('./diagnose.js').Diagnosis} diagnosis
 * @param {number} attempt
 * @param {string} stopReason
 * @param {PlanStep[]} steps
 * @returns {RepairPlan}
 */
function finish(diagnosis, attempt, stopReason, steps) {
  return { version: 1, incident: diagnosis.incident, attempt, createdAt: Date.now(), stopReason, diagnosis, steps }
}

/**
 * @param {RepairPlan} plan
 * @param {string} action
 */
export function nextStep(plan, action) {
  return plan.steps.find((item) => item.action === action && item.status === 'pending')
}

/**
 * @param {RepairPlan} plan
 * @param {PlanStep} step
 * @param {StepStatus} status
 * @param {{ error?: string, detail?: string }} [options]
 */
export function setStep(plan, step, status, options = {}) {
  step.status = status
  if (status === 'running') step.startedAt = Date.now()
  if (status === 'done' || status === 'failed' || status === 'skipped') step.finishedAt = Date.now()
  if (options.error) step.error = options.error
  if (options.detail) step.detail = options.detail
  return plan
}

/** @param {RepairPlan} plan */
export function planSummary(plan) {
  return plan.steps.map((item) => `${item.action}:${item.status}`).join(' -> ')
}
