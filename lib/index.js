// @ts-check
/**
 * dsh-restart-guard — host side.
 *
 * Runs inside the DSH process. It owns three jobs:
 *
 *  1. publish `pid.json` so the detached watcher knows which process to watch;
 *  2. keep a detached watcher alive (start it, adopt a healthy one, sign it a
 *     new one when the plugin version changed);
 *  3. serve the settings page API and replay the IM outbox once this process
 *     is up again.
 *
 * The watcher must never depend on this process: it outlives it by design.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  clearControl,
  dropOutbox,
  listIncidents,
  readOutbox,
  writeControl,
  writePid,
} from './shared/state.js'
import { configPath, dshHome, ensureDir, instanceDir, instanceId, readJson, writeJsonAtomic } from './shared/paths.js'
import { loadConfig, resolveLocale, saveConfig, imCredentials } from './shared/config.js'
import { authorized, metaTag, newToken, readJson as readBody, sendJson } from './shared/http.js'
import { pidAlive, processStartTimeMs } from './shared/probe.js'
import { redactArgv, redactConfig } from './shared/redact.js'
import { buildDoctor } from './doctor.js'
import { listIm, resolveImTarget } from './shared/im.js'
import { aiSettings, buildAiRequest, callAi } from './shared/ai.js'

export const name = 'dsh-restart-guard'
export const inject = ['webServer']

const VERSION = readVersion()
const ROUTE_PREFIX = '/api/restart-guard'
const MAX_BODY = 64 * 1024
const ALLOWED_ACTIONS = new Set([
  'status',
  'pause',
  'resume',
  'reload',
  'test-notify',
  'restart',
  'rollback',
  'start',
  'simulate-crash',
  'stop-guard',
  'maintenance-start',
  'maintenance-end',
  'restore-repair',
])
const MUTATING_ACTIONS = new Set(['restart', 'rollback', 'start', 'simulate-crash', 'stop-guard', 'restore-repair'])

/**
 * @param {any} ctx cordis context
 * @param {any} [rowConfig]
 */
export function apply(ctx, rowConfig = {}) {
  const env = { ...process.env }
  const home = dshHome(env)
  const profile = env.DSH_PROFILE || 'web'
  const token = newToken()
  const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const watcherPath = path.join(pluginRoot, 'lib', 'watcher.mjs')
  const bootedAt = Date.now()

  /** @type {{ dir: string, profile: string, port: number, protocol: string, config: any, issues: any[], watcher: any } | null} */
  let runtime = null
  /** @type {Promise<any> | null} */
  let readyPromise = null
  /** @type {number} */
  let spawnCount = 0
  /** @type {number} */
  let lastReplaceAt = 0
  /** @type {number} */
  let spawnWindowStart = 0
  /** @type {any} */
  let doctorCache = null
  /** @type {number} */
  let doctorAt = 0

  /** @param {'info'|'warn'|'error'} level @param {string} message */
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[restart-guard] ${message}`)
      else if (level === 'error') console.error(`[restart-guard] ${message}`)
    } catch {
      /* logging must never break the host */
    }
  }

  // ---------------------------------------------------------------- lifecycle

  const timer = setInterval(() => {
    ready()
      .then(() => {
        ensureWatcher('tick')
        replayOutbox()
      })
      .catch((error) => log('warn', `tick failed: ${error?.message ?? error}`))
  }, 10_000)
  if (typeof timer.unref === 'function') timer.unref()

  const configTimer = setInterval(() => {
    if (!runtime) return
    try {
      const loaded = loadConfig({ env })
      if (loaded.config) runtime.config = loaded.config
    } catch {
      /* keep the last good config */
    }
  }, 30_000)
  if (typeof configTimer.unref === 'function') configTimer.unref()

  const disposeTaps = ctx.webServer.tapIndex((/** @type {string} */ html) => {
    if (html.includes('dsh-restart-guard-token')) return html
    const tag = metaTag(token)
    return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`
  })

  ctx.effect(() => () => {
    clearInterval(timer)
    clearInterval(configTimer)
    try {
      disposeTaps()
    } catch {
      /* already disposed */
    }
  })

  process.once('exit', () => {
    if (!runtime) return
    try {
      // `process.exitCode` is 0 for clean shutdowns (operator asked the host to
      // stop). A signal-killed process never reaches this handler, which is what
      // we want: upgrades, `kill -9` and crashes must stay recoverable.
      writeControl(runtime.dir, 'exit', { ts: Date.now(), code: process.exitCode ?? 0, hostPid: process.pid })
    } catch {
      /* best effort */
    }
  })

  // ---------------------------------------------------------------- readiness

  function ready() {
    if (readyPromise) return readyPromise
    readyPromise = (async () => {
      const port = await resolvePort()
      if (!port) throw new Error('webServer port is not known yet')
      const protocol = safeProtocol(ctx)
      const dir = instanceDir(env, profile, port)
      ensureDir(dir, 0o700)
      // A stale exit intent from a previous process would make the watcher
      // believe the operator stopped DSH on purpose.
      clearControl(dir, 'exit')
      writePid(dir, {
        pid: process.pid,
        startedAt: processStartTimeMs(process.pid) || bootedAt,
        profile,
        port,
        protocol,
        version: VERSION,
        argv: redactArgv(process.argv),
        sessionId: env.DSH_SESSION_ID ?? '',
        writtenAt: Date.now(),
      })
      const loaded = loadConfig({ env })
      runtime = { dir, profile, port, protocol, config: loaded.config, issues: loaded.issues, watcher: null }
      if (loaded.issues.length > 0) log('warn', `config issues: ${loaded.issues.join('; ')}`)
      ensureWatcher('ready')
      replayOutbox()
      return runtime
    })().catch((error) => {
      readyPromise = null
      throw error
    })
    return readyPromise
  }

  async function resolvePort() {
    for (let index = 0; index < 300; index += 1) {
      const port = Number(ctx.webServer.port)
      if (Number.isInteger(port) && port > 0) return port
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return 0
  }

  /** @param {any} context */
  function safeProtocol(context) {
    try {
      return String(context.webServer.protocol || 'http')
    } catch {
      return 'http'
    }
  }

  // ------------------------------------------------------------- watcher mgmt

  // Single-flight: ready() and the ten-second tick both ask for a watcher, and
  // without this guard they can spawn two within milliseconds of each other.
  let spawning = false
  let lastSpawnAt = 0
  let failedSpawns = 0
  let backoffUntil = 0

  /** @param {'ready'|'tick'} [trigger] */
  function ensureWatcher(trigger = 'tick') {
    if (!runtime) return
    if (spawning) return
    const watcherFile = path.join(runtime.dir, 'watcher.json')
    const current = readJson(watcherFile, null)
    const alive = Boolean(current && pidAlive(current.pid) && Date.now() - Number(current.heartbeatAt || 0) < 20_000)
    runtime.watcher = current
    // Compare against the version on disk, not the one this process booted
    // with: after an update the host keeps running until it is restarted, and
    // its in-memory VERSION would otherwise force a replacement every ten
    // minutes forever.
    if (alive && current.version === readVersion()) return
    // A live watcher of an older version keeps running; replacing it on every
    // tick would be a restart storm. One hand-over per ten minutes is enough.
    if (alive && Date.now() - lastReplaceAt < 10 * 60_000) return

    // Do not spawn a fresh watcher in a tight loop when the script is broken.
    const now = Date.now()
    if (now < backoffUntil) return
    if (now - lastSpawnAt < 15_000) return
    if (now - spawnWindowStart > 10 * 60_000) {
      spawnWindowStart = now
      spawnCount = 0
    }
    if (spawnCount >= 6) {
      log('error', 'watcher keeps dying; giving up until the next host restart')
      return
    }
    spawnCount += 1
    if (alive) lastReplaceAt = Date.now()
    spawning = true
    lastSpawnAt = Date.now()

    const args = [
      watcherPath,
      '--home',
      home,
      '--profile',
      profile,
      '--port',
      String(runtime.port),
      '--instance',
      runtime.dir,
    ]
    if (alive) args.push('--replace')
    try {
      const child = spawn(process.execPath, args, {
        cwd: pluginRoot,
        env: { ...process.env, DSH_HOME: home },
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', (error) => {
        spawning = false
        log('error', `failed to start watcher: ${error.message}`)
      })
      child.unref()
      log('info', `spawn-watcher trigger=${trigger} ${alive ? 'replacing' : 'starting'} pid ${child.pid} for ${instanceId(profile, runtime.port)}`)
      // Confirm the new watcher really took over; a missing pid means the next
      // tick should try again instead of assuming success.
      const expected = child.pid
      const verify = setTimeout(() => {
        spawning = false
        const latest = readJson(watcherFile, null)
        if (!latest || Number(latest.pid) !== Number(expected) || !pidAlive(Number(expected))) {
          failedSpawns += 1
          log('warn', `spawn-failed watcher pid ${expected} did not take over; will retry`)
          if (failedSpawns >= 3) {
            failedSpawns = 0
            backoffUntil = Date.now() + 5 * 60_000
            log('error', 'watcher-flapping; backing off for five minutes instead of spawning on every tick')
          }
        } else {
          failedSpawns = 0
        }
      }, 5000)
      verify.unref?.()
    } catch (error) {
      spawning = false
      log('error', `failed to spawn watcher: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ------------------------------------------------------------- IM outbox

  function imSender() {
    /** @type {any} */
    let service = null
    try {
      service = typeof ctx.get === 'function' ? ctx.get('dshIm') : null
    } catch {
      service = null
    }
    if (!service || typeof service.send !== 'function') return null
    const creds = imCredentials(runtime?.config ?? {}, env)
    return async (/** @type {{ text: string, botId?: string, targetId?: string }} */ input) => {
      const botId = input.botId || creds.botId
      let targetId = input.targetId || creds.targetId
      if (!botId) return { ok: false, detail: 'missing botId' }
      if (!targetId) {
        // QQ and friends may expose only a bot id; accept it when dsh-im has a
        // single saved target, and report exactly what is missing otherwise.
        const resolved = await resolveImTarget(service, { botId })
        if (!resolved.ok) return { ok: false, detail: resolved.reason }
        targetId = resolved.targetId
      }
      try {
        await service.send(botId, targetId, input.text)
        return { ok: true }
      } catch (error) {
        try {
          await service.send({ botId, targetId, text: input.text })
          return { ok: true }
        } catch (second) {
          return { ok: false, detail: String(error ?? second) }
        }
      }
    }
  }

  let replayAt = 0
  async function replayOutbox() {
    if (!runtime) return
    const now = Date.now()
    if (now - replayAt < 60_000) return
    replayAt = now
    const entries = readOutbox(runtime.dir)
    if (entries.length === 0) return
    const send = imSender()
    if (!send) return
    let sent = 0
    for (const item of entries.slice(0, 10)) {
      const entry = item.entry
      if (!entry || entry.channel !== 'im') continue
      const result = await send({ text: String(entry.text ?? ''), botId: entry.botId, targetId: entry.targetId })
      if (result.ok) {
        dropOutbox(runtime.dir, item.name)
        sent += 1
      }
    }
    if (sent > 0) log('info', `replayed ${sent} queued IM notification(s)`)
  }

  /**
   * List the bots and targets dsh-im knows about, so the settings page can offer
   * a picker instead of asking the operator to copy identifiers by hand.
   */
  async function handleImDiscover(_req, res) {
    const info = await discoverIm()
    sendJson(res, 200, { ok: true, ...info })
  }

  async function discoverIm() {
    /** @type {any} */
    let service = null
    try {
      service = ctx.get('dshIm', false)
    } catch {
      service = null
    }
    return await listIm(service)
  }

  // ------------------------------------------------------------------ routes

  /** @type {Array<[string, string, (req: any, res: any) => Promise<void>]>} */
  const routes = [
    ['GET', `${ROUTE_PREFIX}/state`, handleState],
    ['GET', `${ROUTE_PREFIX}/doctor`, handleDoctor],
    ['GET', `${ROUTE_PREFIX}/incidents`, handleIncidents],
    ['POST', `${ROUTE_PREFIX}/config`, handleConfig],
    ['POST', `${ROUTE_PREFIX}/action`, handleAction],
    ['POST', `${ROUTE_PREFIX}/ai-test`, handleAiTest],
    ['GET', `${ROUTE_PREFIX}/im`, handleImDiscover],
  ]

  for (const [method, routePath, handler] of routes) {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
        try {
          if (String(req.method || '').toUpperCase() !== method) {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!authorized(req, token)) {
            sendJson(res, 403, { ok: false, error: 'forbidden: missing or stale guard token (reload the page)' })
            return
          }
          await handler(req, res)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    ctx.effect(() => dispose)
  }

  /** @param {any} req @param {any} res */
  async function handleState(req, res) {
    const rt = await ready()
    const doctor = await getDoctor(rt, false)
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      instance: { id: instanceId(rt.profile, rt.port), profile: rt.profile, port: rt.port, protocol: rt.protocol, dir: rt.dir },
      configPath: configPath(env),
      guardRoot: path.join(home, 'restart-guard'),
      host: { pid: process.pid, startedAt: bootedAt },
      watcher: watcherSummary(rt),
      state: readJson(path.join(rt.dir, 'state.json'), null),
      plan: readJson(path.join(rt.dir, 'control', 'plan.json'), null),
      maintenance: readJson(path.join(rt.dir, 'control', 'maintenance.json'), null),
      outbox: readOutbox(rt.dir).length,
      config: redactConfig(rt.config, { webhookUrl: rt.config.notify?.webhook?.url ?? '' }),
      issues: rt.issues,
      doctor,
    })
  }

  /** @param {any} req @param {any} res */
  async function handleDoctor(req, res) {
    const rt = await ready()
    const doctor = await getDoctor(rt, true)
    sendJson(res, 200, { ok: true, ...doctor })
  }

  /** @param {any} _req @param {any} res */
  async function handleIncidents(_req, res) {
    const rt = await ready()
    sendJson(res, 200, { ok: true, incidents: listIncidents(rt.dir, 20) })
  }

  /** @param {any} req @param {any} res */
  async function handleConfig(req, res) {
    const rt = await ready()
    if (isRemote(req) && !rt.config.security.allowRemoteMutations) {
      sendJson(res, 403, { ok: false, error: 'remote configuration changes are disabled (security.allowRemoteMutations=false)' })
      return
    }
    const parsed = await readBody(req, MAX_BODY)
    if (!parsed.ok) {
      sendJson(res, parsed.status ?? 400, { ok: false, error: parsed.error ?? 'bad request' })
      return
    }
    const body = parsed.value
    const patch = body && typeof body === 'object' && body.patch && typeof body.patch === 'object' ? body.patch : body
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      sendJson(res, 400, { ok: false, error: 'expected a JSON object of configuration values' })
      return
    }
    if (!knownKeys(patch)) {
      sendJson(res, 400, { ok: false, error: 'unknown configuration key in patch' })
      return
    }
    const saved = saveConfig(patch, { env })
    rt.config = saved.config
    rt.issues = saved.issues
    request('reload', { source: 'settings' })
    sendJson(res, 200, {
      ok: true,
      config: redactConfig(saved.config, { webhookUrl: saved.config.notify?.webhook?.url ?? '' }),
      issues: saved.issues,
    })
  }

  /** @param {any} req @param {any} res */
  /**
   * On-demand AI self-test: one redacted log tail in, one verdict out. Nothing
   * is executed; the operator sees whether the endpoint, key and model work.
   * @param {any} req
   * @param {any} res
   */
  async function handleAiTest(req, res) {
    const rt = await ready()
    const parsed = await readBody(req, MAX_BODY)
    if (!parsed.ok) {
      sendJson(res, parsed.status ?? 400, { ok: false, error: parsed.error ?? 'bad request' })
      return
    }
    const settings = aiSettings(rt.config, process.env)
    const state = readJson(path.join(rt.dir, 'state.json'), null)
    let logText = ''
    const bootLog = state && state.boot && typeof state.boot.logPath === 'string' ? state.boot.logPath : ''
    try {
      const size = bootLog ? fs.statSync(bootLog).size : 0
      if (size > 0) {
        const from = Math.max(0, size - settings.maxLogBytes)
        const fd = fs.openSync(bootLog, 'r')
        try {
          const buffer = Buffer.alloc(size - from)
          fs.readSync(fd, buffer, 0, buffer.length, from)
          logText = buffer.toString('utf8')
        } finally {
          fs.closeSync(fd)
        }
      }
    } catch {
      /* no boot log yet: the prompt still works with facts alone */
    }
    const request = buildAiRequest({
      locale: resolveLocale(rt.config, process.env),
      facts: {
        incident: (state && state.incident && state.incident.incident) || 'self-test',
        detail: 'manual self-test requested from the settings page',
        evidence: [],
        attempt: 1,
        maxAttempts: rt.config?.watchdog?.maxRestartAttempts ?? 2,
        port: rt.port,
        profile: rt.profile,
        supervisor: (state && state.supervisor && state.supervisor.kind) || 'unknown',
        maintenance: false,
        patchBackups: 0,
        node: process.version,
        dshVersion: VERSION,
        maxLogBytes: settings.maxLogBytes,
      },
      logText,
    })
    const advice = await callAi({ settings, messages: request.messages })
    if (advice.ok === false) {
      sendJson(res, 200, { ok: false, error: advice.error, model: settings.model, endpoint: settings.endpoint, keyEnv: settings.keyEnv })
      return
    }
    sendJson(res, 200, { ok: true, verdict: advice.verdict, model: settings.model })
  }

  async function handleAction(req, res) {
    const rt = await ready()
    const parsed = await readBody(req, MAX_BODY)
    if (!parsed.ok) {
      sendJson(res, parsed.status ?? 400, { ok: false, error: parsed.error ?? 'bad request' })
      return
    }
    const body = parsed.value
    const action = String(body?.action ?? '')
    if (!ALLOWED_ACTIONS.has(action)) {
      sendJson(res, 400, { ok: false, error: `unknown action "${action}"` })
      return
    }
    if (MUTATING_ACTIONS.has(action)) {
      if (isRemote(req) && !rt.config.security.allowRemoteMutations) {
        sendJson(res, 403, { ok: false, error: 'remote mutations are disabled (security.allowRemoteMutations=false)' })
        return
      }
      if (action === 'simulate-crash' && !rt.config.security.dangerousActions) {
        sendJson(res, 403, { ok: false, error: 'simulate-crash requires security.dangerousActions=true' })
        return
      }
    }
    if (action === 'maintenance-start') {
      const minutes = Math.max(1, Math.min(24 * 60, Number(body?.minutes) || 15))
      writeControl(rt.dir, 'maintenance', { until: Date.now() + minutes * 60_000, reason: String(body?.reason ?? 'operator') })
      sendJson(res, 200, { ok: true, maintenance: readJson(path.join(rt.dir, 'control', 'maintenance.json'), null) })
      return
    }
    if (action === 'maintenance-end') {
      clearControl(rt.dir, 'maintenance')
      sendJson(res, 200, { ok: true })
      return
    }
    const requestId = request(action, { source: 'settings', reason: String(body?.reason ?? '') })
    sendJson(res, 200, { ok: true, requestId })
  }

  /** @param {any} req */
  function isRemote(req) {
    const headers = req?.headers ?? {}
    return Boolean(headers['cf-connecting-ip'] || headers['x-real-ip'] || headers['x-forwarded-for'] || headers.forwarded)
  }

  /** @param {any} patch */
  function knownKeys(patch) {
    const defaults = loadConfig({ env }).config
    for (const key of Object.keys(patch)) {
      if (!(key in defaults)) return false
    }
    return true
  }

  /** @param {string} action @param {Record<string, unknown>} extra */
  function request(action, extra = {}) {
    if (!runtime) throw new Error('guard is not ready')
    ensureDir(path.join(runtime.dir, 'control', 'requests'), 0o700)
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    writeJsonAtomic(path.join(runtime.dir, 'control', 'requests', name), {
      action,
      requestedAt: Date.now(),
      requesterPid: process.pid,
      ...extra,
    })
    return name
  }

  /** @param {any} rt */
  function watcherSummary(rt) {
    const current = readJson(path.join(rt.dir, 'watcher.json'), null)
    const alive = Boolean(current && pidAlive(current.pid) && Date.now() - Number(current.heartbeatAt || 0) < 20_000)
    return current ? { alive, pid: current.pid, heartbeatAt: current.heartbeatAt, version: current.version, phase: current.phase } : { alive: false, pid: 0, heartbeatAt: 0, version: '', phase: '' }
  }

  /** @param {any} rt @param {boolean} refresh */
  async function getDoctor(rt, refresh) {
    const now = Date.now()
    if (!refresh && doctorCache && now - doctorAt < 10_000) return doctorCache
    const watcher = watcherSummary(rt)
    let probe = null
    try {
      const { probeDshStack } = await import('./shared/probe.js')
      probe = await probeDshStack({ port: rt.port, timeoutMs: 2000, protocol: rt.protocol })
    } catch {
      probe = null
    }
    const im = await discoverIm().catch(() => null)
    const state = readJson(path.join(rt.dir, 'state.json'), null)
    doctorCache = buildDoctor({
      env,
      port: rt.port,
      profile: rt.profile,
      instanceDir: rt.dir,
      config: rt.config,
      watcher,
      imAvailable: Boolean(imSender()),
      imInfo: im,
      repair: state?.repair ?? null,
      probe,
    })
    doctorAt = now
    return doctorCache
  }
}

/** @returns {string} */
function readVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
    return String(manifest.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

export { resolveLocale }
