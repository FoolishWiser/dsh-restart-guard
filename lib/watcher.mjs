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
import { httpProbe, findPidsByPort, isZombie, pidAlive, pidCmdline, pidGone, portOpen, processStartTimeMs } from './shared/probe.js'
import { applySupervisorMode, detectSupervisor } from './shared/supervision.js'
import { captureLaunch, captureSelf, loadLaunchSpec, storeLaunchSpec, specSummary } from './shared/launch.js'
import { detectMaintenance, treeSnapshot } from './shared/maintenance.js'
import { parseBootFailure, tailSegment } from './shared/diagnose.js'
import { planRepairSteps, setStep, planSummary } from './shared/plan.js'
import { aiSettings, buildAiRequest, callAi, applyAiVerdict, buildRepairPrompt, repairWithAi, isProtectedPackage } from './shared/ai.js'
import { buildEnvironment, renderEnvironment, summarizeEnvironment } from './shared/environment.js'
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
import {
  spawnDsh,
  verifyBoot,
  rollbackProfilePatch,
  findOccupant,
  killStaleDsh,
  bootLogPath,
  patchBackups,
  resolveFailingPackage,
  applyAiEdits,
  restoreAiEdits,
  disablePatchEntry,
  restorePatchEntry,
  buildPluginMaterial,
} from './repair.js'
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
  let liveStdout = ''
  try {
    if (host.pid > 0) liveStdout = fs.readlinkSync(`/proc/${host.pid}/fd/1`)
  } catch {
    liveStdout = ''
  }
  const candidates = [
    override,
    loadLaunchSpec(dir)?.stdoutPath ?? '',
    // Ask the live host where its stdout goes instead of guessing a path: a
    // second instance must never append to another instance's log.
    liveStdout,
    process.env.DSH_WEB_LOG ?? '',
  ].filter((item) => typeof item === 'string' && item.length > 0)
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return null
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

/** @type {any} */
let host = { pid: 0, startedAt: 0, protocol: 'http', argv: [], version: '' }
// Where the guard's own lines are mirrored matters for container debugging:
// record it instead of leaving a bare `mirror=?` in the report.
const mirrorPath = mirrorTarget()
state.diagnostics = { ...(state.diagnostics ?? {}), mirror: mirrorPath ? 'on' : 'off', mirrorPath: mirrorPath || '' }

/** @type {ReturnType<typeof detectSupervisor>} */
let detectedSupervisor = detectSupervisor({ env, ppid: process.ppid })
/** @type {ReturnType<typeof detectSupervisor>} */
let supervisor = applySupervisorMode(detectedSupervisor, config.supervision.mode)
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

/**
 * Stop controls are addressed to one watcher. A predecessor's stop must stay
 * readable until that predecessor exits, so a successor never clears it and
 * only acts on the stop that names its own pid.
 * @returns {any | null}
 */
function myStopControl() {
  const stop = readControl(dir, 'stop')
  if (!stop) return null
  const target = Number(stop.targetPid) || 0
  if (!target) {
    // Legacy stop (0.1.4 and older): only act on it when nobody else holds the
    // lock, which means it was written during our own startup.
    const owner = readJson(lockPath, null)
    return Number(owner?.pid) === process.pid ? stop : null
  }
  return target === process.pid ? stop : null
}

/** @returns {number} pid of a live watcher holding the lock, 0 when we own it */
function lockConflict() {
  const owner = readJson(lockPath, null)
  const pid = Number(owner?.pid) || 0
  if (!pid || pid === process.pid) return 0
  return pidAlive(pid) ? pid : 0
}

/** @param {number} pid @param {number} timeoutMs */
async function waitPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pidGone(pid)) return true
    await sleep(200)
  }
  return pidGone(pid)
}

function heartbeat() {
  try {
    if (lockConflict()) return
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
  const mirrorNow = mirrorTarget()
  state.diagnostics = { ...(state.diagnostics ?? {}), mirror: mirrorNow ? 'on' : 'off', mirrorPath: mirrorNow || '' }

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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: VERSION }))
      fs.closeSync(fd)
      // A handover stop belongs to the predecessor that still has to read it.
      // Only a stop aimed at us (or a legacy stop without a target, written by
      // an older version for this very process) is cleared here.
      const handover = readControl(dir, 'stop')
      if (handover) {
        const target = Number(handover.targetPid) || 0
        if (target === process.pid) clearControl(dir, 'stop')
        log('info', 'lock-handover', `acquired the lock; predecessor stop targets pid ${target || 'any'}`)
      }
      return true
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') {
        log('error', 'lock', String(error))
        return false
      }
    }
    const raw = readJson(lockPath, null)
    if (raw === null) {
      // Either the owner is mid-write (open + write are two calls) or the file
      // is truncated. Deleting it here is the TOCTOU that let two watchers run:
      // wait for the owner to finish writing instead.
      sleepSync(100)
      continue
    }
    const pid = Number(raw?.pid) || 0
    const cmdline = pid > 0 ? pidCmdline(pid).join(' ') : ''
    const alive = pid > 0 && pidAlive(pid)
    const isWatcher = alive && /watcher\.mjs/.test(cmdline)
    if (!isWatcher) {
      if (!alive) {
        // The owner is dead: the lock is stale no matter how fresh its mtime
        // is (a SIGKILL leaves a brand-new file behind).
        try {
          fs.rmSync(lockPath, { force: true })
        } catch {
          /* ignore */
        }
        continue
      }
      const age = Date.now() - mtimeMs(lockPath)
      if (alive) {
        // A live pid with an unreadable cmdline may still be the owner (hidepid,
        // a re-exec); never delete a lock a live process may hold.
        sleepSync(100)
        continue
      }
      if (age > 30_000 || pid === 0) {
        try {
          fs.rmSync(lockPath, { force: true })
        } catch {
          /* ignore */
        }
        continue
      }
      sleepSync(100)
      continue
    }
    if (replace && attempt < 25) {
      log('info', 'lock-replace', `asking watcher ${pid} to step down`)
      writeControl(dir, 'stop', { ts: Date.now(), targetPid: pid, reason: 'replaced by a newer watcher' })
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
  // The alert file exists to catch a human's eye while the service is down.
  // Once the port is back there is nothing left to act on; a stale ALERT.md
  // would make every successful drill look like a failure.
  if (resolution !== 'manual' && resolution !== 'failed') {
    try {
      fs.rmSync(path.join(dir, 'ALERT.md'), { force: true })
    } catch {
      /* ignore */
    }
  }
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
  state.expectedStop = null

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

  if (maintenance?.active) {
    // Stand down visually, but do not stay there once the restarter is gone.
    state.phase = 'maintenance'
  } else if (state.phase !== 'manual' && state.phase !== 'paused' && state.phase !== 'stopped') {
    if (state.phase === 'maintenance') log('info', 'maintenance-end', 'service is healthy again; resuming monitoring')
    state.maintenanceNotifyKey = ''
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
    // The maintenance window is not an incident: dedupe on the signal set so a
    // restarter visible on every probe notifies once per window, not once per tick.
    const windowKey = `${maintenance.signal}|${maintenance.signals.join(';')}`.slice(0, 800)
    if (state.maintenanceNotifyKey !== windowKey) {
      state.maintenanceNotifyKey = windowKey
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

  // The guard itself stopped the host (simulate-crash / restart drill). That is
  // a planned outage: skip the stalled wait and start a replacement now.
  const expected = state.expectedStop
  if (expected && !state.incident && Number(expected.pid) > 0 && now - Number(expected.at ?? 0) <= 120_000) {
    const plannedPid = Number(expected.pid)
    state.expectedStop = null
    log('info', 'expected-stop', `pid ${plannedPid} was stopped by the guard; restarting without a stalled wait`)
    startIncident(
      {
        incident: 'down',
        detail: `host pid ${plannedPid} was stopped by the guard drill and port ${port} is not answering`,
        evidence: ['expected-stop'],
        unresolved: [],
        inactive: [],
      },
      'drill',
    )
  }

  // The process is alive but the port has been dead past stalledExitMs. Only a
  // live process that still looks like `dsh web` and is not a zombie counts:
  // otherwise the repair ladder would try to kill something that cannot serve
  // the port and never reach the start step.
  const livePid = state.startedPid && pidAlive(state.startedPid) ? state.startedPid : host.pid
  const liveCmd = livePid > 0 && pidAlive(livePid) ? pidCmdline(livePid).join(' ') : ''
  const liveLooksLikeDsh = /\bdsh\b|bin\.js/.test(liveCmd) && /\bweb\b/.test(liveCmd)
  if (livePid > 0 && pidAlive(livePid) && !liveLooksLikeDsh && !state.incident) {
    if (state.startedPid === livePid) state.startedPid = 0
    log('info', 'stale-pid', `pid ${livePid} is alive but is not dsh web; treating the port as down`)
  }
  const stalled =
    pidAlive(livePid) &&
    liveLooksLikeDsh &&
    !isZombie(livePid) &&
    now - state.probe.downtimeSince > config.watchdog.stalledExitMs &&
    !state.incident
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
 * Execute the plugin repair the AI proposed. Edits land inside the plugin
 * directory only; a disable falls back to the profile patch layer. The guard
 * keeps the backup paths so the operator can undo the repair later.
 *
 * @param {any} verdict
 * @param {{ spec: any, diagnosis: import('./shared/diagnose.js').Diagnosis, profileDir: string, profileName: string }} input
 */
async function applyPluginRepair(verdict, { spec, diagnosis, profileDir, profileName }) {
  const at = Date.now()
  const incidentId = state.incident?.id ?? ''
  const entryName = String(verdict.entryName || diagnosis.entryName || '').trim()
  if (verdict.action === 'fix-plugin') {
    if (!entryName) return { ok: false, reason: 'the boot log did not name the failing package' }
    const resolved = resolveFailingPackage({ profileDir, entryName })
    if (resolved.ok === false) return { ok: false, reason: /** @type {any} */ (resolved).error }
    const applied = applyAiEdits({ packageDir: resolved.dir, edits: verdict.edits ?? [] })
    if (!applied.ok) return { ok: false, reason: applied.error }
    state.repair = {
      kind: 'fix-plugin',
      side: 'ai',
      at,
      incidentId,
      entryId: diagnosis.entryId ?? '',
      entryName,
      packageDir: resolved.dir,
      changed: applied.changed.map((item) => ({ file: item.file, abs: item.abs, backup: item.backup, bytes: item.bytes })),
      reason: verdict.reason ?? '',
    }
    return { ok: true, detail: `${entryName}: ${applied.changed.map((item) => item.file).join(', ')}`, repair: state.repair }
  }
  const entryId = String(verdict.entryId || diagnosis.entryId || '').trim()
  if (!entryId) return { ok: false, reason: 'the verdict named no loader entry to disable' }
  if (isProtectedPackage(entryName)) return { ok: false, reason: `${entryName || 'the entry'} is protected` }
  const disabled = disablePatchEntry({ profileDir, profile: profileName, spec, entryId, entryName })
  if (!disabled.ok) return { ok: false, reason: disabled.error }
  state.repair = {
    kind: 'disable-plugin',
    side: 'ai',
    at,
    incidentId,
    entryId,
    entryName,
    patchPath: disabled.patchPath,
    backupPath: disabled.backup,
    reason: verdict.reason ?? '',
  }
  return { ok: true, detail: `loader entry ${entryId} disabled`, repair: state.repair }
}

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

  // --- AI repair (full permissions) ----------------------------------------
  // Runs before the rule ladder when the boot log already names the failing
  // plugin, and again inside the ladder once a failed boot produced a precise
  // diagnosis. The model may only propose bounded file edits; the guard
  // validates, backs them up and restarts.
  /** @type {() => Promise<void>} */
  const aiActRepair = async () => {
    if (aiUsed || state.repair) return
    const hardStop = maintenance?.active === true || (supervisor.kind !== 'none' && supervisor.mayAct === false)
    if (hardStop) return
    aiUsed = true
      aiUsed = true
      try {
        const settings = aiSettings(config, env)
        const spec = loadLaunchSpec(dir)
        const environment = await buildEnvironment({
          env: baseEnv,
          port,
          profile: host.profile || profile,
          instanceDir: dir,
          guardVersion: VERSION,
          supervisor,
          maintenance,
          state,
          diagnosis,
          dshVersion: host.version,
        })
        const logPath = bootLogPath({ spec, config, fallback: environment.bootLogPath })
        const profileDir = path.join(home, 'profiles', host.profile || profile)
        /** @type {string} */
        let material = ''
        if (diagnosis.entryName) {
          const failing = resolveFailingPackage({ profileDir, entryName: diagnosis.entryName })
          if (failing.ok) {
            material = buildPluginMaterial({
              packageDir: failing.dir,
              entryId: diagnosis.entryId,
              entryName: diagnosis.entryName,
              required: diagnosis.required,
            })
          }
        }
        const prompt = buildRepairPrompt({
          locale: resolveLocale(config, env),
          environment: renderEnvironment(environment),
          logText: logTailText(spec),
          port,
          profile: host.profile || profile,
          binPath: spec?.binPath || 'dsh',
          logPath,
          maxLogBytes: Math.max(Number(settings.maxLogBytes) || 8192, 12000),
          material,
        })
        log('info', 'ai-repair', `start (${settings.order}) ${summarizeEnvironment({ ...environment, bootLogPath: logPath })}`)
        const result = await repairWithAi({
          settings,
          prompt,
          profile: host.profile || profile,
          cwd: spec?.cwd || process.cwd(),
          env: { DSH_HOME: home },
        })
        state.ai = {
          mode: 'act',
          at: Date.now(),
          ok: result.ok,
          via: result.via || '',
          notes: (result.notes ?? []).slice(0, 4),
          verdict: result.verdict ?? null,
          order: settings.order,
        }
        const verdict = result.verdict
        const pluginRepair = result.ok && verdict && (verdict.action === 'fix-plugin' || verdict.action === 'disable-plugin')
        if (pluginRepair) {
          const applied = await applyPluginRepair(verdict, {
            spec,
            diagnosis,
            profileDir,
            profileName: host.profile || profile,
          })
          if (applied.ok) {
            log('info', 'ai-fixed', `${result.via}: ${applied.detail}`)
          } else {
            log('warn', 'ai-repair-rejected', applied.reason)
          }
        } else if (result.ok) {
          log('info', 'ai-repaired', `${result.via} finished; re-probing the port`)
          const verify = await httpProbe({ port, timeoutMs: config.watchdog.probeTimeoutMs, protocol: host.protocol === 'https' ? 'https' : 'http' })
          if (verify.ok) {
            state.health = { ok: true, kind: verify.kind, status: verify.status, checkedAt: Date.now(), error: '' }
            await resolveIncident('ai', `repaired by ${result.via}`)
            return
          }
          log('warn', 'ai-no-effect', `${result.via} reported success but the port still does not answer`)
        } else {
          log('warn', 'ai-unavailable', (result.notes ?? []).join('; ').slice(0, 400) || 'no channel succeeded')
        }
      } catch (/** @type {any} */ error) {
        log('warn', 'ai-repair', String(error?.message ?? error))
        state.ai = { mode: 'act', at: Date.now(), ok: false, via: '', notes: [String(error?.message ?? error)], verdict: null }
      }
      try {
        writeJsonAtomic(path.join(dir, 'control', 'ai.json'), state.ai ?? {})
      } catch {
        /* ignore */
      }
  }

  if (config.ai.enabled && config.ai.mode === 'act') await aiActRepair()

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
    if (state.repair && state.repair.incidentId === incident.id && !plan.steps.some((item) => item.action === state.repair?.kind)) {
      plan.repair = state.repair
      plan.steps.unshift({
        id: 'ai-repair',
        action: /** @type {any} */ (state.repair.kind),
        status: 'done',
        detail: state.repair.kind === 'fix-plugin'
          ? `AI repaired ${state.repair.entryName}: ${(state.repair.changed ?? []).map((item) => item.file).join(', ')}`
          : `AI disabled loader entry ${state.repair.entryId}`,
      })
    }
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
          entryName: diagnosis.entryName ?? '',
          corePackage: isProtectedPackage(diagnosis.entryName ?? ''),
        })
        if (merged.ok && merged.applied && (advice.verdict.action === 'fix-plugin' || advice.verdict.action === 'disable-plugin')) {
          const applied = await applyPluginRepair(advice.verdict, {
            spec: loadLaunchSpec(dir),
            diagnosis,
            profileDir,
            profileName: host.profile || profile,
          })
          if (applied.ok) log('info', 'ai-fixed', applied.detail)
          else log('warn', 'ai-repair-rejected', applied.reason)
        }
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
      /** @type {string[]} */
      const preSkipped = []
      if (diagnosis.incident === 'stalled') {
        const stalledPid = state.startedPid && pidAlive(state.startedPid) ? state.startedPid : host.pid
        if (stalledPid > 0 && isZombie(stalledPid)) preSkipped.push(`pid ${stalledPid} zombie`)
        else if (stalledPid > 0 && pidGone(stalledPid)) preSkipped.push(`pid ${stalledPid} gone`)
        else if (stalledPid > 0) targets.push(stalledPid)
      }
      else if (occupant.isDsh) targets.push(...occupant.pids)
      let killed = targets.length > 0
      /** @type {string[]} */
      const errors = []
      /** @type {string[]} */
      const skipped = [...preSkipped]
      for (const pid of targets) {
        const result = await killStaleDsh({ pid, port })
        if (result.skipped) {
          skipped.push(`pid ${pid} ${result.skipped}`)
          log('info', 'kill-stale-skipped', `pid ${pid} is ${result.skipped}; continuing to start`)
          continue
        }
        if (!result.ok) {
          killed = false
          errors.push(result.error)
        }
      }
      if (targets.length === 0) {
        killed = false
        errors.push('no DSH pid found for the port')
      }
      if (errors.length > 0) {
        setStep(plan, killStep, 'failed', { error: errors.join('; ') })
        await failIncident(plan, `could not stop the stale holder: ${errors.join('; ')}`)
        return
      }
      if (killed) setStep(plan, killStep, 'done')
      else setStep(plan, killStep, 'skipped', { detail: skipped.join('; ') || 'nothing to stop' })
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
    if (verify.reason === 'startup-failed' && spawn.pid > 0 && pidAlive(spawn.pid)) {
      try {
        process.kill(spawn.pid, 'SIGTERM')
      } catch {
        /* ignore */
      }
      await waitPidGone(spawn.pid, 3000)
      if (pidAlive(spawn.pid)) {
        try {
          process.kill(spawn.pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
        await waitPidGone(spawn.pid, 3000)
      }
      log('warn', 'boot-kill', `stopped the half-started boot (pid ${spawn.pid})`)
      state.startedPid = 0
    }
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
      required: parsed.required,
      failedPlugins: parsed.failedPlugins,
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
    // The failed boot named the plugin: let the AI repair it before the next try.
    if (!state.repair && config.ai.enabled && config.ai.mode === 'act' && diagnosis.entryName) {
      aiUsed = false
      await aiActRepair()
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
  if (action === 'restore-repair') {
    const repair = state.repair
    if (!repair) return { ok: false, detail: 'no AI repair is recorded' }
    if (repair.kind === 'fix-plugin') {
      const restored = restoreAiEdits({ changed: repair.changed ?? [] })
      if (!restored.ok) return { ok: false, detail: `restore failed: ${restored.errors.join('; ')}` }
      state.repair = null
      return { ok: true, detail: `restored ${restored.restored} file(s); restart DSH to load the original plugin` }
    }
    if (repair.kind === 'disable-plugin') {
      const restored = restorePatchEntry({ patchPath: repair.patchPath, backup: repair.backupPath })
      if (!restored.ok) return { ok: false, detail: `restore failed: ${restored.error}` }
      state.repair = null
      return { ok: true, detail: 'the loader entry is enabled again; restart DSH to load it' }
    }
    return { ok: false, detail: `unknown repair kind ${repair.kind}` }
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
    writeControl(dir, 'stop', { ts: Date.now(), targetPid: process.pid, reason: 'operator request' })
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
    state.expectedStop = { pid: host.pid, at: Date.now() }
    try {
      process.kill(host.pid, 'SIGKILL')
    } catch (error) {
      state.expectedStop = null
      return { ok: false, detail: `cannot kill pid ${host.pid}: ${String(error)}` }
    }
    // A killed child of PID 1 may linger as a zombie; wait for "gone" (zombie
    // counts as gone) so the recovery path does not treat it as a stalled host.
    const gone = await waitPidGone(host.pid, 3000)
    state.phase = 'starting'
    state.probe.downtimeSince = Date.now()
    log('info', 'simulate-crash', `pid ${host.pid} ${gone ? 'is gone' : 'is still visible after 3s'}`)
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
      const conflict = lockConflict()
      if (conflict) {
        log('warn', 'lock-lost', `watcher ${conflict} owns the lock; standing down`)
        break
      }
      const stop = myStopControl()
      if (stop) {
        log('info', 'stop', `stop control for pid ${process.pid}; exiting`)
        clearControl(dir, 'stop')
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
        previous: state.maintenance ? { signal: state.maintenance.signal, until: state.maintenance.until } : null,
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
