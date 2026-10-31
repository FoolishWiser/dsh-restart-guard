#!/usr/bin/env node
// @ts-check
/**
 * dsh-restart-guard watcher.
 *
 * A small, dependency-free daemon that outlives `dsh web`. It is spawned
 * detached by the host plugin (or by the CLI) and keeps the instance state in
 * `$DSH_HOME/restart-guard/instances/<profile>-<port>/`.
 *
 * Contract with the host plugin:
 *   - host writes `pid.json` (host pid, start time, protocol, version),
 *     `control/exit.json` on graceful exit, and `control/requests/*.json`.
 *   - watcher writes `state.json`, `watcher.json`, `incidents/`, `outbox/`,
 *     `ALERT.md`, `control/plan.json`, `control/results/*.json`.
 *   - no file is written by both sides.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { dshHome, instanceDir, instanceId, ensureDir, sleep, readJson, writeJsonAtomic, mtimeMs } from './shared/paths.js'
import { loadConfig, resolveLocale } from './shared/config.js'
import { createLogger } from './shared/log.js'
import { httpProbe, findPidsByPort, pidAlive, pidCmdline, portOpen, processStartTimeMs } from './shared/probe.js'
import { applySupervisorMode, detectSupervisor } from './shared/supervision.js'
import { captureLaunch, captureSelf, loadLaunchSpec, storeLaunchSpec, specSummary } from './shared/launch.js'
import { detectMaintenance, treeSnapshot } from './shared/maintenance.js'
import { parseBootFailure, tailSegment } from './shared/diagnose.js'
import { planRepairSteps, setStep, planSummary } from './shared/plan.js'
import { aiSettings, buildAiRequest, callAi, applyAiVerdict } from './shared/ai.js'
import {
  defaultState,
  readState,
  writeState,
  readPid,
  readBaseline,
  writeBaseline,
  readControl,
  writeControl,
  clearControl,
  pendingRequests,
  claimRequest,
  pruneClaimed,
  saveIncident,
  pruneOutbox,
  writeAlert,
} from './shared/state.js'
import { spawnDsh, verifyBoot, rollbackProfilePatch, findOccupant, killStaleDsh, bootLogPath, patchBackups } from './repair.js'
import { buildReport, deliver, hintFor } from './shared/notify.js'
import { redactText, redactArgv } from './shared/redact.js'

/** Package version — kept in sync with package.json instead of a literal, so a
 * published update and a running watcher never disagree about the version. */
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const args = parseArgs({
  options: {
    home: { type: 'string' },
    profile: { type: 'string' },
    port: { type: 'string' },
    instance: { type: 'string' },
    replace: { type: 'boolean' },
    'foreground': { type: 'boolean' },
  },
  allowPositionals: false,
})

const env = process.env
const home = args.values.home || dshHome(env)
const profile = args.values.profile || env.DSH_PROFILE || 'web'
const port = Number(args.values.port) || 3079
const instance = args.values.instance || instanceId(profile, port)
const baseEnv = { ...env, DSH_HOME: home }
const dir = args.values.instance ? path.resolve(args.values.instance) : instanceDir(baseEnv, profile, port)
ensureDir(dir, 0o700)

const configPath = path.join(home, 'restart-guard', 'config.json')
/** @type {ReturnType<typeof loadConfig>} */
let loaded = loadConfig({ env: baseEnv })
let config = loaded.config
let configMtime = loaded.mtimeMs
/**
 * Where to echo guard lines so they also show up in the container log. In a
 * container the host's stdout is the stream the runtime captured
 * (`/app/.dsh-web.log` under the launcher, `/tmp/...` for a restarter); appending
 * to that same file puts repairs next to the server's own boot lines.
 *
 * @returns {string | null}
 */
function mirrorTarget() {
  if (config.logs?.mirrorToHostLog === false) return null
  const override = typeof config.logs?.bootLogPath === 'string' ? config.logs.bootLogPath : ''
  const candidate = override || loadLaunchSpec(dir)?.stdoutPath || ''
  if (!candidate || !path.isAbsolute(candidate)) return null
  try {
    if (!fs.statSync(candidate).isFile()) return null
  } catch {
    return null
  }
  return candidate
}

const logger = createLogger({
  file: path.join(dir, 'restart-guard.log'),
  maxBytes: 5 * 1024 * 1024,
  keep: 2,
  mirror: mirrorTarget,
  secrets: () => [config.notify.webhook.secret, config.notify.webhook.url, config.notify.im.botId].filter(Boolean),
})

/** @typedef {ReturnType<typeof defaultState>} State */

/** @type {State} */
let state = readState(dir) ?? defaultState({ profile, port, watcherPid: process.pid })
state.watcher = { ...state.watcher, pid: process.pid, startedAt: state.watcher?.startedAt ?? Date.now() }
state.profile = profile
state.port = port

/** @type {ReturnType<typeof detectSupervisor>} */
let detectedSupervisor = detectSupervisor({ env, ppid: process.ppid })
/** @type {ReturnType<typeof detectSupervisor>} */
let supervisor = applySupervisorMode(detectedSupervisor, config.supervision.mode)
/** @type {any} */
let host = { pid: 0, startedAt: 0, protocol: 'http', argv: [], version: '' }
/** @type {import('./shared/maintenance.js').MaintenanceStatus | null} */
let maintenance = null
let stopping = false
let abortVerify = false
let lastBaselineAt = 0
let lastCaptureAt = 0
let lockPath = ''

process.on('uncaughtException', (error) => {
  try {
    logger.error('uncaught', String(error?.stack ?? error))
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (error) => {
  try {
    logger.error('unhandled', String(/** @type {any} */ (error)?.stack ?? error))
  } catch {
    /* ignore */
  }
})

for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])) {
  process.on(signal, () => {
    stopping = true
    abortVerify = true
  })
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function log(level, event, message, data) {
  logger[level](event, redactText(message), data)
}

function nowIso() {
  return new Date().toISOString()
}

/** @param {any} value */
function writeStateSafe(value) {
  try {
    writeState(dir, value)
  } catch (error) {
    log('warn', 'state-write', String(error))
  }
}

function heartbeat() {
  try {
    writeJsonAtomic(path.join(dir, 'watcher.json'), {
      version: VERSION,
      pid: process.pid,
      startedAt: state.watcher.startedAt,
      heartbeatAt: Date.now(),
      profile,
      port,
      phase: state.phase,
      startMs: processStartTimeMs(process.pid),
    })
  } catch {
    /* ignore */
  }
}

function reloadConfigIfChanged() {
  let changed = false
  try {
    changed = mtimeMs(configPath) !== configMtime && mtimeMs(configPath) !== 0
  } catch {
    changed = false
  }
  if (!changed) return
  const next = loadConfig({ env: baseEnv })
  config = next.config
  configMtime = next.mtimeMs
  supervisor = applySupervisorMode(detectedSupervisor, config.supervision.mode)
  log('info', 'config-reload', `${next.issues.length} issue(s)`, next.issues.slice(0, 5))
  // A config change may pause or re-enable the guard.
  if (!config.enabled) log('info', 'config-disabled', 'running in observe-only mode')
}

/** @param {number} pid */
function readHostEnv(pid) {
  if (process.platform !== 'linux' || !pid) return {}
  try {
    /** @type {Record<string, string>} */
    const out = {}
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const index = entry.indexOf('=')
      if (index > 0) out[entry.slice(0, index)] = entry.slice(index + 1)
    }
    return out
  } catch {
    return {}
  }
}

/** @param {number} pid */
function readHostPpid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    return Number(stat.slice(close + 2).trim().split(/\s+/)[1]) || process.ppid
  } catch {
    return process.ppid
  }
}

function readHost() {
  const pid = readPid(dir) ?? {}
  return {
    pid: Number(pid.pid) || 0,
    startedAt: Number(pid.startedAt) || 0,
    protocol: pid.protocol === 'https' ? 'https' : 'http',
    argv: Array.isArray(pid.argv) ? pid.argv : [],
    version: String(pid.version ?? ''),
    profile: String(pid.profile ?? profile),
  }
}

/** @type {number} */
let lastStalePid = 0
function syncHost(nextHost) {
  // `pid.json` is written by the host plugin. When it is absent (the guard was
  // started by hand, or the host died) keep whatever pid the health loop has
  // adopted: otherwise every probe would reset state.host and re-adopt, and a
  // repaired server would look like a brand new stranger on every tick.
  if (!(nextHost.pid > 0)) return
  if (!pidAlive(nextHost.pid)) {
    if (nextHost.pid !== state.host.pid && nextHost.pid !== lastStalePid) {
      lastStalePid = nextHost.pid
      log('warn', 'stale-pidfile', `pid.json points at pid ${nextHost.pid}, which is gone; keeping the adopted host`)
    }
    return
  }
  const changed = nextHost.pid !== state.host.pid || nextHost.startedAt !== state.host.startedAt
  host = nextHost
  if (!changed) return
  state.host = {
    pid: nextHost.pid,
    argv: redactArgv(nextHost.argv ?? []),
    startedAt: nextHost.startedAt,
    cwd: '',
    startMs: 0,
    cmdline: (nextHost.argv ?? []).join(' '),
    envKeys: [],
  }
  log('info', 'host-change', `pid ${nextHost.pid} startedAt ${nextHost.startedAt || 'unknown'}`)

  if (nextHost.pid > 0) {
    // Fail safe: never replace the launch recipe with this watcher's own argv.
    // A stale/dead pid must leave the previous recipe in place, otherwise the
    // next repair would run `node watcher.mjs` instead of `node dsh web`.
    const captured =
      captureLaunch(nextHost.pid) ??
      (state.startedPid && pidAlive(state.startedPid) ? captureLaunch(state.startedPid) : null) ??
      loadLaunchSpec(dir)
    const spec = captured && !String(captured.argv[1] ?? '').endsWith('watcher.mjs') ? captured : null
    if (!spec) log('warn', 'launch-capture-failed', `could not read a usable argv for pid ${nextHost.pid}; keeping the stored launch spec`)
    if (spec) {
      storeLaunchSpec(dir, spec)
      lastCaptureAt = Date.now()
      state.host.cwd = spec.cwd
      state.host.startMs = spec.startMs
      state.host.cmdline = redactArgv(spec.argv ?? []).join(' ')
      state.host.envKeys = Object.keys(spec.env ?? {}).sort()
      if (!host.protocol) host.protocol = 'http'
      log('info', 'launch-captured', `argv=${JSON.stringify(specSummary(spec).argv)} cwd=${spec.cwd}`)
    }
    detectedSupervisor = detectSupervisor({ env: readHostEnv(nextHost.pid), ppid: readHostPpid(nextHost.pid) })
    const supervisorNext = applySupervisorMode(detectedSupervisor, config.supervision.mode)
    supervisor = supervisorNext
    state.supervisor = { kind: supervisorNext.kind, detail: supervisorNext.detail }
  }

  const exitIntent = readControl(dir, 'exit')
  if (exitIntent && nextHost.startedAt && Number(exitIntent.ts) >= 0 && nextHost.startedAt > Number(exitIntent.ts)) {
    clearControl(dir, 'exit')
  }

  if (Date.now() - lastBaselineAt > 5000) {
    const snapshot = treeSnapshot(path.join(home, 'profiles', host.profile || profile), specBin())
    writeBaseline(dir, { ...snapshot, recordedAt: Date.now() })
    lastBaselineAt = Date.now()
  }

  // A brand new host process resets any terminal phase: re-evaluate from scratch.
  if (state.phase === 'manual' || state.phase === 'stopped' || state.phase === 'stopped-by-guard') {
    state.phase = 'starting'
    state.incident = null
    state.plan = null
  }
}

function specBin() {
  const spec = loadLaunchSpec(dir)
  return spec?.binPath || '/usr/local/bin/dsh'
}

/** @param {string} content */
function alertMarkdown(content) {
  try {
    writeAlert(dir, content)
  } catch (error) {
    log('warn', 'alert-write', String(error))
  }
}

function bootLogFor(spec) {
  return bootLogPath({ spec, config, fallback: path.join(dir, 'boot.log') })
}

function logTailText(spec) {
  const logPath = bootLogFor(spec)
  const tail = tailSegment(logPath, 256 * 1024)
  return tail.text
}

/**
 * @param {string} event
 * @param {Record<string, string|number|boolean>} marks
 * @param {{ force?: boolean, logText?: string }} [options]
 */
async function notifyEvent(event, marks, options = {}) {
  const locale = resolveLocale(config, env)
  const spec = loadLaunchSpec(dir)
  const text = options.logText ?? logTailText(spec)
  const report = buildReport({ locale, event, marks: { port, profile, ...marks }, config, logText: text })
  const deliveries = await deliver({
    config,
    env,
    report,
    locale,
    instanceDir: dir,
    logger,
    imSender: null,
  })
  log('info', 'notify', `${event}: ${deliveries.map((item) => `${item.channel}=${item.ok ? 'ok' : 'fail'}`).join(',') || 'log-only'}`)
  if (report.severity === 'error') alertMarkdown(`${report.markdown}\n\n_${nowIso()}_\n`)
  return deliveries
}

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

/**
 * One watcher per instance. A stale lock (dead pid, or a pid that is not this
 * script) is taken over; `--replace` asks a live predecessor to step down.
 */
function acquireLock() {
  lockPath = path.join(dir, 'watcher.lock')
  const replace = Boolean(args.values.replace)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: VERSION }))
      fs.closeSync(fd)
      // Taking over from a predecessor leaves its "step down" stop control
      // behind. That instruction belonged to the watcher that already exited;
      // keeping it would make this process quit on its first loop iteration.
      const handover = readControl(dir, 'stop')
      if (handover && String(handover.reason ?? '').startsWith('replaced by a newer watcher')) {
        clearControl(dir, 'stop')
        log('info', 'lock-handover', `took over from pid ${handover.hostPid ?? 'unknown'}`)
      }
      return true
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') {
        log('error', 'lock', String(error))
        return false
      }
    }
    const existing = readJson(lockPath, null)
    const pid = Number(existing?.pid) || 0
    const cmdline = pid > 0 ? pidCmdline(pid).join(' ') : ''
    const isWatcher = pid > 0 && pidAlive(pid) && /watcher\.mjs/.test(cmdline)
    if (!isWatcher) {
      try {
        fs.rmSync(lockPath, { force: true })
      } catch {
        /* ignore */
      }
      continue
    }
    if (replace && attempt < 20) {
      log('info', 'lock-replace', `asking watcher ${pid} to step down`)
      writeControl(dir, 'stop', { ts: Date.now(), reason: 'replaced by a newer watcher' })
      sleepSync(500)
      continue
    }
    log('warn', 'lock', `another watcher is active (pid ${pid})`)
    return false
  }
  return false
}

/** @param {number} ms */
function sleepSync(ms) {
  // Only used during startup lock handling, before the main loop starts.
  const buffer = new Int32Array(new SharedArrayBuffer(4))
  let remaining = ms
  while (remaining > 0) {
    Atomics.wait(buffer, 0, 0, Math.min(50, remaining))
    remaining -= 50
  }
}

function releaseLock() {
  try {
    const existing = readJson(lockPath, null)
    if (Number(existing?.pid) === process.pid) fs.rmSync(lockPath, { force: true })
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// incident bookkeeping
// ---------------------------------------------------------------------------

/**
 * @param {import('./shared/diagnose.js').Diagnosis} diagnosis
 * @param {string} source
 */
function startIncident(diagnosis, source) {
  const createdAt = Date.now()
  state.incident = {
    id: String(createdAt),
    createdAt,
    updatedAt: createdAt,
    incident: diagnosis.incident,
    detail: diagnosis.detail,
    evidence: diagnosis.evidence.slice(0, 5),
    entryId: diagnosis.entryId ?? '',
    entryName: diagnosis.entryName ?? '',
    source,
    attempts: 0,
    startedPids: [],
    resolvedAt: 0,
    resolution: '',
    notified: {},
  }
  return state.incident
}

/** @param {string} event */
function notified(event) {
  return Boolean(state.incident?.notified?.[event])
}

/** @param {string} event */
function markNotified(event) {
  if (!state.incident) return
  state.incident.notified[event] = Date.now()
  state.incident.updatedAt = Date.now()
}

async function notifyIncident(event, marks, options = {}) {
  if (notified(event) && !options.force) return
  markNotified(event)
  await notifyEvent(event, marks, options)
}

/**
 * @param {string} resolution
 * @param {string} note
 */
async function resolveIncident(resolution, note) {
  const incident = state.incident
  if (!incident) return
  incident.resolvedAt = Date.now()
  incident.resolution = resolution
  incident.updatedAt = Date.now()
  const elapsed = Math.round((incident.resolvedAt - incident.createdAt) / 1000)
  saveIncident(dir, incident, config.retention.incidents)
  await notifyIncident('repaired', { incident: incident.incident, elapsed, note }, { force: true })
  log('info', 'incident-resolved', `${incident.incident} after ${elapsed}s (${resolution})`)
  state.incident = null
  state.plan = null
  if (state.phase === 'restarting' || state.phase === 'verified' || state.phase === 'starting') state.phase = 'monitoring'
}

// ---------------------------------------------------------------------------
// health handling
// ---------------------------------------------------------------------------

/** @param {any} probe */
async function onHealthy(probe) {
  state.health = { ok: true, kind: probe.kind, status: probe.status, checkedAt: Date.now(), error: '' }
  state.probe.consecutiveDown = 0
  state.probe.downtimeSince = 0
  state.boot = { ...state.boot, state: 'ready' }

  if (state.incident) await resolveIncident((state.incident.startedPids ?? []).length > 0 ? 'auto' : 'external', '')

  // Adopt whatever process is actually serving the port (it may not be the one
  // we knew about: an upgrade script or a supervisor may have started it).
  if (!pidAlive(host.pid)) {
    const occupant = findOccupant(port)
    const fresh = occupant.pids[0] ?? 0
    if (fresh > 0 && occupant.isDsh) {
      const spec = captureLaunch(fresh)
      if (spec) {
        storeLaunchSpec(dir, spec)
        state.host.pid = fresh
        host = { ...host, pid: fresh, startedAt: host.startedAt || Date.now() }
        state.host.cmdline = redactArgv(spec.argv).join(' ')
        log('info', 'host-adopted', `pid ${fresh} is serving port ${port}`)
      }
    }
  }

  const captureDue = Date.now() - lastCaptureAt > 60000 && pidAlive(host.pid)
  if (captureDue) {
    const spec = captureLaunch(host.pid)
    if (spec) {
      storeLaunchSpec(dir, spec)
      lastCaptureAt = Date.now()
    }
  }
  if (Date.now() - lastBaselineAt > 120000) {
    const snapshot = treeSnapshot(path.join(home, 'profiles', host.profile || profile), specBin())
    writeBaseline(dir, { ...snapshot, recordedAt: Date.now() })
    lastBaselineAt = Date.now()
  }

  if (state.phase !== 'manual' && state.phase !== 'paused' && state.phase !== 'stopped' && state.phase !== 'maintenance') {
    state.phase = 'monitoring'
  }
}

/**
 * @param {any} probe
 * @param {number} now
 */
/**
 * True when the TCP port still answers even though the HTTP probe timed out:
 * the server is up but busy, which must never be treated as a crash.
 * @param {{ ok: boolean, status: number, error?: string }} probe
 */
async function slowButListening(probe) {
  if (!probe.ok && (probe.error === 'ETIMEDOUT' || probe.error === 'timeout' || String(probe.error ?? '').includes('timed out'))) {
    return portOpen(port)
  }
  return false
}

async function onUnhealthy(probe, now) {
  state.health = { ok: false, kind: probe.kind, status: probe.status, checkedAt: Date.now(), error: String(probe.error ?? '') }
  state.probe.consecutiveDown += 1
  if (!state.probe.downtimeSince) state.probe.downtimeSince = now
  const downSec = Math.round((now - state.probe.downtimeSince) / 1000)

  if (state.phase === 'monitoring') state.phase = 'starting'

  // Someone stopped it on purpose: respect the operator.
  const exitIntent = readControl(dir, 'exit')
  if (
    config.watchdog.respectIntentionalStop &&
    exitIntent &&
    Number(exitIntent.code) === 0 &&
    now - Number(exitIntent.ts) < 45000 &&
    !maintenance?.active
  ) {
    state.phase = 'stopped'
    if (state.incident) {
      state.incident.resolvedAt = now
      state.incident.resolution = 'intentional'
      saveIncident(dir, state.incident, config.retention.incidents)
      state.incident = null
    }
    return
  }

  // Pause control wins over everything except the health snapshot.
  const pause = readControl(dir, 'pause')
  if (pause && Number(pause.until) > now) {
    state.phase = 'paused'
    return
  }

  if (maintenance?.active) {
    state.phase = 'maintenance'
    if (!notified('maintenance')) {
      markNotified('maintenance')
      await notifyEvent('maintenance', {
        signals: maintenance.signals.join('; ').slice(0, 600),
        until: new Date(maintenance.until ?? now).toISOString(),
      })
    }
    return
  }

  if (supervisor.kind !== 'none' && !supervisor.mayAct) {
    state.phase = 'manual'
    if (!state.incident) startIncident({ incident: 'supervised', detail: supervisor.detail, evidence: [], unresolved: [], inactive: [] }, 'supervisor')
    if (!notified('supervised')) {
      markNotified('supervised')
      await notifyEvent('supervised', { detail: supervisor.detail })
    }
    return
  }

  if (state.phase === 'manual' || state.phase === 'paused' || state.phase === 'stopped') return

  // The process is alive but the port has been dead past stalledExitMs.
  const livePid = state.startedPid && pidAlive(state.startedPid) ? state.startedPid : host.pid
  const stalled =
    pidAlive(livePid) && now - state.probe.downtimeSince > config.watchdog.stalledExitMs && !state.incident
  if (stalled) {
    const diagnosis = {
      incident: 'stalled',
      detail: `pid ${livePid} is alive but port ${port} has not answered for ${downSec}s`,
      evidence: [pidCmdline(livePid).join(' ').slice(0, 200)],
      unresolved: [],
      inactive: [],
    }
    startIncident(diagnosis, 'stalled')
  }

  // Grace period + restart arbitration.
  const graceEnd = state.probe.downtimeSince + config.watchdog.startupGraceMs
  if (!state.incident && now < graceEnd) {
    state.phase = 'starting'
    return
  }

  if (!state.incident) {
    const restarters = maintenance?.restarters ?? []
    if ((restarters.length > 0 || (await portOpen(port, { timeoutMs: 500 }))) && state.probe.extensions < config.arbitration.maxExtensions) {
      state.probe.extensions = (state.probe.extensions ?? 0) + 1
      state.probe.downtimeSince = now
      log('info', 'arbitration', `another restarter is active (${restarters.map((item) => item.pid).join(',') || 'port came back'}); waiting ${config.arbitration.extraGraceMs}ms more`)
      state.phase = 'starting'
      return
    }
  }

  // Crash loop: too many failures in the window.
  const windowStart = now - config.watchdog.crashLoop.windowMs
  state.restarts = (state.restarts ?? []).filter((ts) => Number(ts) > windowStart)
  if (state.restarts.length >= config.watchdog.crashLoop.maxIncidents) {
    writeControl(dir, 'pause', {
      until: now + config.watchdog.crashLoop.pauseMs,
      reason: 'crash loop',
      createdAt: now,
    })
    state.phase = 'paused'
    if (!notified('flapping')) {
      markNotified('flapping')
      await notifyEvent('flapping', {
        count: state.restarts.length,
        windowMin: Math.round(config.watchdog.crashLoop.windowMs / 60000),
        until: new Date(now + config.watchdog.crashLoop.pauseMs).toISOString(),
      })
    }
    return
  }

  const diagnosis =
    state.incident?.incident && state.incident.incident !== 'stalled'
      ? {
          incident: state.incident.incident,
          detail: state.incident.detail,
          evidence: state.incident.evidence ?? [],
          unresolved: [],
          inactive: [],
        }
      : state.incident
        ? {
            incident: 'stalled',
            detail: state.incident.detail,
            evidence: state.incident.evidence ?? [],
            unresolved: [],
            inactive: [],
          }
        : parseBootFailure(logTailText(loadLaunchSpec(dir)))

  if (!state.incident) startIncident(diagnosis, 'down')

  await notifyIncident('down', {
    downSec,
    kind: probe.kind,
    incident: diagnosis.incident,
    detail: diagnosis.detail,
    hint: hintFor(resolveLocale(config, env), diagnosis.incident),
  })

  if (!config.enabled) {
    state.phase = 'manual'
    return
  }
  await repair(diagnosis)
}

// ---------------------------------------------------------------------------
// repair
// ---------------------------------------------------------------------------

/**
 * @param {import('./shared/diagnose.js').Diagnosis} initialDiagnosis
 */
async function repair(initialDiagnosis) {
  const incident = state.incident
  if (!incident) return
  state.phase = 'restarting'
  let diagnosis = initialDiagnosis
  let rollbackUsed = false
  let killUsed = false
  const maxAttempts = Math.max(1, config.watchdog.maxRestartAttempts)
  const occupant = findOccupant(port)
  let attemptNo = 0
  let aiUsed = false

  while (attemptNo < maxAttempts) {
    attemptNo += 1
    if (stopping || abortVerify) break
    const pause = readControl(dir, 'pause')
    if (pause && Number(pause.until) > Date.now()) {
      state.phase = 'paused'
      return
    }
    if (!state.incident) return

    const plan = planRepairSteps({
      diagnosis,
      attempt: attemptNo,
      config,
      maintenance: maintenance ?? {
        active: false,
        signal: 'none',
        signals: [],
        until: 0,
        terminal: 'unknown',
        treeIntact: true,
        treeVersion: '',
        upgradeDir: '',
        restarters: [],
      },
      supervisor,
      occupant,
      port,
    })
    state.plan = plan
    try {
      writeJsonAtomic(path.join(dir, 'control', 'plan.json'), plan)
    } catch {
      /* ignore */
    }
    log('info', 'plan', `${diagnosis.incident}: ${planSummary(plan)}`)

    if (plan.stopReason === 'maintenance' || plan.stopReason === 'tree-incomplete' || plan.stopReason === 'supervised') {
      state.phase = plan.stopReason === 'maintenance' ? 'maintenance' : 'manual'
      return
    }

    // --- optional AI second opinion -----------------------------------------
    // Only when the rule-based ladder has no safe move left. The verdict is
    // mapped onto existing actions; model output is never executed.
    /** @type {string} */
    let aiHint = ''
    if (!aiUsed && config.ai.enabled && plan.steps.some((item) => item.action === 'manual')) {
      aiUsed = true
      const settings = aiSettings(config, env)
      const profileDir = path.join(home, 'profiles', host.profile || profile)
      const backups = patchBackups(profileDir).length
      const request = buildAiRequest({
        locale: resolveLocale(config, env),
        facts: {
          incident: diagnosis.incident,
          detail: diagnosis.detail,
          evidence: diagnosis.evidence,
          attempt: attemptNo,
          maxAttempts,
          port,
          profile: host.profile || profile,
          supervisor: supervisor.kind,
          maintenance: maintenance?.active === true,
          patchBackups: backups,
          node: process.version,
          dshVersion: state.host?.version ?? '',
          maxLogBytes: settings.maxLogBytes,
        },
        logText: logTailText(loadLaunchSpec(dir)),
      })
      const advice = await callAi({ settings, messages: request.messages })
      if (advice.ok === true) {
        const merged = applyAiVerdict(plan, advice.verdict, {
          hasBackups: backups > 0,
          attempt: attemptNo,
          occupantIsForeign: occupant.pids.length > 0 && !occupant.isDsh,
        })
        plan.ai = {
          model: settings.model,
          at: Date.now(),
          action: advice.verdict.action,
          reason: advice.verdict.reason,
          hint: advice.verdict.hint,
          confidence: advice.verdict.confidence,
          applied: merged.ok && merged.applied,
          note: merged.reason,
        }
        if (merged.ok && merged.applied) aiHint = advice.verdict.hint
        else aiHint = advice.verdict.hint || merged.reason || advice.verdict.reason
        log('info', 'ai-verdict', `${advice.verdict.action} conf=${advice.verdict.confidence} — ${merged.reason}`)
        try {
          writeJsonAtomic(path.join(dir, 'control', 'plan.json'), plan)
        } catch {
          /* ignore */
        }
      } else {
        log('warn', 'ai-unavailable', advice.error)
      }
    }

    // --- rollback -----------------------------------------------------------
    const rollbackStep = plan.steps.find((item) => item.action === 'rollback-patch')
    if (rollbackStep && !rollbackUsed) {
      setStep(plan, rollbackStep, 'running')
      const spec = loadLaunchSpec(dir)
      const profileDir = path.join(home, 'profiles', host.profile || profile)
      const result = rollbackProfilePatch({ profileDir, profile: host.profile || profile, spec })
      rollbackUsed = true
      if (result.ok) {
        setStep(plan, rollbackStep, 'done', { error: '' })
        log('info', 'rollback', `applied ${result.applied}; broken file kept at ${result.brokenPath}`)
      } else {
        setStep(plan, rollbackStep, 'failed', { error: result.error })
        log('warn', 'rollback-failed', result.error)
        await failIncident(plan, `patch rollback failed: ${result.error}`, { reason: result.error })
        return
      }
    }

    // --- kill stale holder --------------------------------------------------
    const killStep = plan.steps.find((item) => item.action === 'kill-stale')
    if (killStep && !killUsed) {
      setStep(plan, killStep, 'running')
      killUsed = true
      /** @type {number[]} */
      const targets = []
      if (diagnosis.incident === 'stalled') {
        const stalledPid = state.startedPid && pidAlive(state.startedPid) ? state.startedPid : host.pid
        if (pidAlive(stalledPid)) targets.push(stalledPid)
      }
      else if (occupant.isDsh) targets.push(...occupant.pids)
      let killed = targets.length > 0
      /** @type {string[]} */
      const errors = []
      for (const pid of targets) {
        const result = await killStaleDsh({ pid, port })
        if (!result.ok) {
          killed = false
          errors.push(result.error)
        }
      }
      if (targets.length === 0) {
        killed = false
        errors.push('no DSH pid found for the port')
      }
      if (killed) {
        setStep(plan, killStep, 'done')
      } else {
        setStep(plan, killStep, 'failed', { error: errors.join('; ') })
        await failIncident(plan, `could not stop the stale holder: ${errors.join('; ')}`)
        return
      }
    }

    const manualStep = plan.steps.find((item) => item.action === 'manual')
    if (manualStep) {
      await failIncident(plan, manualStep.detail, { hint: aiHint || hintFor(resolveLocale(config, env), diagnosis.incident) })
      return
    }

    if (plan.stopReason === 'attempts-exhausted') {
      await failIncident(plan, 'restart budget exhausted')
      return
    }

    // --- start + verify -----------------------------------------------------
    const spec = loadLaunchSpec(dir) ?? (pidAlive(host.pid) ? captureLaunch(host.pid) : null)
    if (!spec) {
      await failIncident(plan, 'no launch spec was captured; cannot start DSH', { hint: hintFor(resolveLocale(config, env), 'manual') })
      return
    }
    const logPath = bootLogFor(spec)
    const spawn = spawnDsh({ spec, logPath, port, attempt: plan.attempt })
    if (!spawn.ok) {
      await failIncident(plan, `spawn failed: ${spawn.error ?? 'unknown'}`)
      return
    }
    incident.attempts += 1
    state.restarts = [...(state.restarts ?? []), Date.now()].slice(-50)
    state.boot = {
      state: 'booting',
      attempt: incident.attempts,
      startedAt: Date.now(),
      logPath,
      logOffset: spawn.offset,
      pid: spawn.pid,
      deadline: Date.now() + config.watchdog.bootTimeoutMs,
      accessLine: '',
      settleUntil: 0,
    }
    state.startedPid = spawn.pid
    incident.startedPids = [...(incident.startedPids ?? []), spawn.pid]
    if (!notified('repairStarted')) {
      markNotified('repairStarted')
      await notifyEvent('repairStarted', {
        incident: diagnosis.incident,
        detail: diagnosis.detail,
        plan: planSummary(plan),
        hint: hintFor(resolveLocale(config, env), diagnosis.incident),
      })
    }
    log('info', 'spawn', `pid ${spawn.pid} attempt ${incident.attempts} log=${logPath} offset=${spawn.offset}`)
    spawn.child?.once('exit', (code, signal) => {
      log('warn', 'child-exit', `pid ${spawn.pid} code=${code} signal=${signal}`)
    })
    writeStateSafe(state)

    const verify = await verifyBoot({
      child: spawn.child ?? null,
      logPath,
      offset: spawn.offset,
      config,
      port,
      protocol: host.protocol === 'https' ? 'https' : 'http',
      abort: () => stopping || abortVerify,
    })
    state.boot.state = verify.ok ? 'ready' : verify.reason === 'timeout' ? 'timeout' : 'failed'
    state.boot.accessLine = verify.accessLine
    if (verify.ok) {
      state.phase = 'verified'
      state.startedPid = spawn.pid
      const elapsed = Math.round((Date.now() - incident.createdAt) / 1000)
      incident.attempts = incident.attempts
      log('info', 'verified', `pid ${spawn.pid} after ${verify.elapsedMs}ms (${verify.reason})`)
      await resolveIncident('auto', verify.note ?? '')
      state.phase = 'monitoring'
      void elapsed
      return
    }

    log('warn', 'verify-failed', `${verify.reason} after ${verify.elapsedMs}ms`)
    const parsed = parseBootFailure(verify.segment)
    diagnosis = {
      incident: verify.reason === 'timeout' ? 'timeout' : parsed.incident,
      detail:
        verify.reason === 'timeout'
          ? `DSH did not answer within ${config.watchdog.bootTimeoutMs}ms`
          : parsed.incident === 'unknown'
            ? `boot failed (${verify.reason})`
            : parsed.detail,
      evidence: [...(parsed.evidence ?? []), verify.note ?? ''].filter(Boolean).slice(0, 5),
      entryId: parsed.entryId,
      entryName: parsed.entryName,
      unresolved: parsed.unresolved,
      inactive: parsed.inactive,
    }
    incident.incident = diagnosis.incident
    incident.detail = diagnosis.detail
    incident.evidence = diagnosis.evidence
    if (verify.reason === 'foreign-listener') {
      await failIncident(plan, `another service is answering on port ${port}`, { hint: hintFor(resolveLocale(config, env), 'port-in-use') })
      return
    }
    await sleep(3000)
  }

  if (stopping) return
  await failIncident(state.plan, `tried ${config.watchdog.maxRestartAttempts} restart(s); DSH still does not answer`)
}

/**
 * @param {any} plan
 * @param {string} reason
 * @param {{ hint?: string, reason?: string }} [options]
 */
async function failIncident(plan, reason, options = {}) {
  const incident = state.incident
  if (!incident) return
  state.phase = 'manual'
  state.lastError = reason
  incident.failureReason = reason
  const hint = options.hint ?? hintFor(resolveLocale(config, env), incident.incident)
  if (plan) {
    for (const item of plan.steps) {
      if (item.status === 'pending' || item.status === 'running') setStep(plan, item, 'skipped')
    }
  }
  incident.resolvedAt = 0
  saveIncident(dir, incident, config.retention.incidents)
  await notifyIncident('repairFailed', {
    incident: incident.incident,
    detail: incident.detail,
    stopReason: reason.slice(0, 300),
    hint,
  })
  log('error', 'repair-failed', reason)
  alertMarkdown(`# DSH restart guard — manual action required\n\n- incident: ${incident.incident}\n- detail: ${incident.detail}\n- reason: ${reason}\n- hint: ${hint}\n- at: ${nowIso()}\n\nSee \`${path.join(dir, 'restart-guard.log')}\` and the boot log tail.\n`)
}

// ---------------------------------------------------------------------------
// operator requests
// ---------------------------------------------------------------------------

async function handleRequests() {
  for (const { name, request } of pendingRequests(dir)) {
    if (!claimRequest(dir, name)) continue
    /** @type {{ ok: boolean, detail: string }} */
    let result = { ok: false, detail: 'unknown action' }
    try {
      result = await runRequest(request)
    } catch (error) {
      result = { ok: false, detail: String(error) }
    }
    try {
      const results = path.join(dir, 'control', 'results')
      ensureDir(results, 0o700)
      writeJsonAtomic(path.join(results, `${name}.json`), { request, result, at: Date.now() })
    } catch {
      /* ignore */
    }
    log('info', 'request', `${request?.action}: ${result.ok ? 'ok' : 'failed'} ${result.detail}`.slice(0, 400))
  }
  pruneClaimed(dir)
}

/**
 * @param {any} request
 * @returns {Promise<any>}
 */
async function runRequest(request) {
  const action = String(request?.action ?? '')
  const currentMaintenance = maintenance
  if (currentMaintenance?.active && !['test-notify', 'status', 'pause', 'resume', 'reload'].includes(action)) {
    return { ok: false, detail: `maintenance window active (${currentMaintenance.signal}); refusing ${action}` }
  }
  if (action === 'status') {
    return { ok: true, detail: `phase=${state.phase} health=${state.health.ok} incident=${state.incident?.incident ?? 'none'}` }
  }
  if (action === 'pause') {
    const minutes = Math.max(1, Math.min(24 * 60, Number(request?.minutes) || 60))
    writeControl(dir, 'pause', { until: Date.now() + minutes * 60000, reason: String(request?.reason ?? 'operator pause'), createdAt: Date.now() })
    state.phase = 'paused'
    return { ok: true, detail: `paused for ${minutes} minute(s)` }
  }
  if (action === 'resume') {
    clearControl(dir, 'pause')
    state.phase = 'starting'
    state.probe.downtimeSince = Date.now()
    return { ok: true, detail: 'resumed' }
  }
  if (action === 'reload') {
    const next = loadConfig({ env: baseEnv })
    config = next.config
    configMtime = next.mtimeMs
    return { ok: true, detail: 'config reloaded' }
  }
  if (action === 'ai-test') {
    const settings = aiSettings(config, env)
    const profileDir = path.join(home, 'profiles', host.profile || profile)
    const request = buildAiRequest({
      locale: resolveLocale(config, env),
      facts: {
        incident: state.incident?.incident ?? 'self-test',
        detail: 'manual AI self-test requested by the operator',
        evidence: [],
        attempt: 1,
        maxAttempts: config.watchdog.maxRestartAttempts,
        port,
        profile: host.profile || profile,
        supervisor: supervisor.kind,
        maintenance: maintenance?.active === true,
        patchBackups: patchBackups(profileDir).length,
        node: process.version,
        dshVersion: state.host?.version ?? '',
        maxLogBytes: settings.maxLogBytes,
      },
      logText: logTailText(loadLaunchSpec(dir)),
    })
    const advice = await callAi({ settings, messages: request.messages })
    if (advice.ok === false) return { ok: false, detail: `AI test failed: ${advice.error}` }
    return {
      ok: true,
      detail: `AI verdict: ${advice.verdict.action} (confidence ${advice.verdict.confidence}) — ${advice.verdict.reason}`,
      verdict: advice.verdict,
    }
  }
  if (action === 'test-notify') {
    await notifyEvent('test', { phase: state.phase })
    return { ok: true, detail: 'test notification dispatched' }
  }
  if (action === 'stop-guard') {
    stopping = true
    writeControl(dir, 'stop', { ts: Date.now(), reason: 'operator request' })
    return { ok: true, detail: 'watcher stopping' }
  }
  if (action === 'restart') {
    const spec = loadLaunchSpec(dir) ?? (pidAlive(host.pid) ? captureLaunch(host.pid) : null)
    if (!spec) return { ok: false, detail: 'no launch spec captured' }
    if (pidAlive(host.pid)) {
      try {
        process.kill(host.pid, 'SIGTERM')
      } catch (error) {
        return { ok: false, detail: `cannot signal pid ${host.pid}: ${String(error)}` }
      }
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && pidAlive(host.pid)) await sleep(250)
      if (pidAlive(host.pid)) {
        try {
          process.kill(host.pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
    const diagnosis = { incident: 'manual-restart', detail: 'an operator asked for a restart', evidence: [], unresolved: [], inactive: [] }
    startIncident(diagnosis, 'manual')
    await repair(diagnosis)
    return { ok: state.phase === 'monitoring' || state.phase === 'verified', detail: `phase=${state.phase}` }
  }
  if (action === 'rollback') {
    const spec = loadLaunchSpec(dir)
    const profileDir = path.join(home, 'profiles', host.profile || profile)
    const result = rollbackProfilePatch({ profileDir, profile: host.profile || profile, spec })
    return { ok: result.ok, detail: result.ok ? `applied ${result.applied}` : result.error }
  }
  if (action === 'start') {
    if (await portOpen(port, { timeoutMs: 500 })) return { ok: false, detail: `port ${port} is already in use` }
    const diagnosis = { incident: 'manual-start', detail: 'an operator asked to start DSH', evidence: [], unresolved: [], inactive: [] }
    startIncident(diagnosis, 'manual')
    await repair(diagnosis)
    return { ok: state.phase === 'monitoring' || state.phase === 'verified', detail: `phase=${state.phase}` }
  }
  if (action === 'simulate-crash') {
    if (!config.security.dangerousActions) return { ok: false, detail: 'dangerousActions is disabled in the guard config' }
    if (!pidAlive(host.pid)) return { ok: false, detail: 'the host process is not running' }
    if (!/dsh/.test(pidCmdline(host.pid).join(' '))) return { ok: false, detail: 'the host pid does not look like dsh' }
    try {
      process.kill(host.pid, 'SIGKILL')
    } catch (error) {
      return { ok: false, detail: `cannot kill pid ${host.pid}: ${String(error)}` }
    }
    state.phase = 'starting'
    state.probe.downtimeSince = Date.now()
    return { ok: true, detail: `killed pid ${host.pid}; watching the recovery` }
  }
  return { ok: false, detail: `unknown action ${action}` }
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

async function main() {
  if (!acquireLock()) {
    log('warn', 'lock', 'another watcher owns this instance; exiting')
    process.exit(0)
  }
  log('info', 'start', `version=${VERSION} profile=${profile} port=${port} dir=${dir}`)
  heartbeat()

  let lastPhase = state.phase
  let lastStateWrite = 0

  while (!stopping) {
    const tickStart = Date.now()
    try {
      reloadConfigIfChanged()
      if (readControl(dir, 'stop')) {
        log('info', 'stop', 'stop control present; exiting')
        break
      }

      syncHost(readHost())
      await handleRequests()

      const now = Date.now()
      const pause = readControl(dir, 'pause')
      if (pause && Number(pause.until) <= now) clearControl(dir, 'pause')
      const activePause = pause && Number(pause.until) > now
      const explicit = readControl(dir, 'maintenance')
      maintenance = detectMaintenance({
        now,
        config,
        env: baseEnv,
        instance: {
          dir,
          hostPid: host.pid,
          pkgRoot: '',
          profileDir: path.join(home, 'profiles', host.profile || profile),
          binPath: specBin(),
          baseline: readBaseline(dir),
        },
        explicit,
      })
      state.maintenance = {
        active: maintenance.active,
        signal: maintenance.signal,
        signals: maintenance.signals.slice(0, 8),
        until: maintenance.until ?? 0,
        terminal: maintenance.terminal,
        treeIntact: maintenance.treeIntact,
        treeVersion: maintenance.treeVersion,
      }

      const probe = await httpProbe({ port, timeoutMs: config.watchdog.probeTimeoutMs, protocol: host.protocol === 'https' ? 'https' : 'http' })
      state.checks += 1

      if (activePause) {
        state.health = { ok: probe.ok, kind: probe.kind, status: probe.status, checkedAt: Date.now(), error: String(probe.error ?? '') }
        state.phase = 'paused'
      } else if (probe.ok) {
        await onHealthy(probe)
      } else if (await slowButListening(probe)) {
        // A loaded host can accept the connection and still miss the probe
        // deadline (plugin start-up, a big render). That is not an outage:
        // restarting here would kill a healthy server during its worst moment.
        state.health = { ok: true, kind: 'dsh', status: probe.status || 0, checkedAt: Date.now(), error: 'slow' }
        state.probe.consecutiveDown = 0
        state.probe.downtimeSince = 0
        if (state.phase === 'starting') state.phase = 'monitoring'
      } else {
        await onUnhealthy(probe, now)
      }

      if (state.phase !== lastPhase) {
        log('info', 'phase', `${lastPhase} -> ${state.phase}`)
        lastPhase = state.phase
      }
    } catch (error) {
      log('error', 'loop', String(/** @type {any} */ (error)?.stack ?? error))
      state.lastError = String(/** @type {any} */ (error)?.message ?? error)
    }

    if (stopping) break
    if (Date.now() - lastStateWrite > 1000) {
      writeStateSafe(state)
      heartbeat()
      lastStateWrite = Date.now()
    }
    const elapsed = Date.now() - tickStart
    await sleep(Math.max(200, config.watchdog.probeIntervalMs - elapsed))
  }

  // Shutdown: leave the phase honest for the next watcher.
  if (state.phase !== 'stopped' && state.phase !== 'manual') {
    state.phase = state.phase === 'monitoring' ? 'stopping' : state.phase
  }
  writeStateSafe(state)
  releaseLock()
  log('info', 'exit', `phase=${state.phase}`)
  pruneOutbox(dir, config.retention.outboxHours)
  process.exit(0)
}

process.on('exit', () => {
  try {
    releaseLock()
  } catch {
    /* ignore */
  }
})

await main()
