// @ts-check
/**
 * Instance state and control files. One writer per file (the watcher owns
 * state.json/pid.json; the host plugin only writes control files), and every
 * write is atomic (tmp + rename) so a crash never leaves a half-written file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from './paths.js'

/** @typedef {'starting'|'monitoring'|'restarting'|'verified'|'manual'|'maintenance'|'paused'|'stopped'|'stopped-by-guard'|'stopping'} Phase */

/**
 * @param {{ profile: string, port: number, watcherPid: number }} input
 */
export function defaultState({ profile, port, watcherPid }) {
  return {
    version: 1,
    profile,
    port,
    phase: /** @type {Phase} */ ('starting'),
    since: Date.now(),
    updatedAt: Date.now(),
    watcher: { pid: watcherPid, startedAt: Date.now(), mode: 'primary' },
    host: { pid: 0, argv: [], cwd: '', startMs: 0, cmdline: '', envKeys: [] },
    supervisor: { kind: 'none', detail: '' },
    health: { ok: false, kind: 'unknown', status: 0, checkedAt: 0, error: '' },
    probe: { intervalMs: 2000, downtimeSince: 0, consecutiveDown: 0, extensions: 0 },
    boot: { state: 'unknown', attempt: 0, startedAt: 0, logPath: '', logOffset: 0, pid: 0, deadline: 0, accessLine: '', settleUntil: 0 },
    incident: null,
    plan: null,
    maintenance: { active: false, signal: 'none', signals: [], until: 0, terminal: 'unknown', treeIntact: true, treeVersion: '' },
    lastError: '',
    restarts: [],
    startedPid: 0,
    checks: 0,
  }
}

/** @param {string} dir */
export function readState(dir) {
  return readJson(path.join(dir, 'state.json'), null)
}

/** @param {string} dir @param {any} state */
export function writeState(dir, state) {
  state.updatedAt = Date.now()
  writeJsonAtomic(path.join(dir, 'state.json'), state)
  return state
}

/** @param {string} dir */
export function readPid(dir) {
  return readJson(path.join(dir, 'pid.json'), null)
}

/** @param {string} dir @param {any} value */
export function writePid(dir, value) {
  writeJsonAtomic(path.join(dir, 'pid.json'), value)
}

/** @param {string} dir */
export function readBaseline(dir) {
  return readJson(path.join(dir, 'baseline.json'), null)
}

/** @param {string} dir @param {any} value */
export function writeBaseline(dir, value) {
  writeJsonAtomic(path.join(dir, 'baseline.json'), value)
}

/** @param {string} dir */
export function readHints(dir) {
  return readJson(path.join(dir, 'hints.json'), { version: 1, hints: {} })
}

/** @param {string} dir @param {any} value */
export function writeHints(dir, value) {
  writeJsonAtomic(path.join(dir, 'hints.json'), value)
}

/** @param {string} dir @param {'maintenance'|'pause'|'exit'|'stop'} name */
export function readControl(dir, name) {
  return readJson(path.join(dir, 'control', `${name}.json`), null)
}

/** @param {string} dir @param {'maintenance'|'pause'|'exit'|'stop'} name @param {any} value */
export function writeControl(dir, name, value) {
  ensureDir(path.join(dir, 'control'), 0o700)
  writeJsonAtomic(path.join(dir, 'control', `${name}.json`), value)
  return value
}

/** @param {string} dir @param {'maintenance'|'pause'|'exit'|'stop'} name */
export function clearControl(dir, name) {
  try {
    fs.rmSync(path.join(dir, 'control', `${name}.json`), { force: true })
  } catch {
    /* ignore */
  }
}

/**
 * Requests dropped by the host plugin (or by the CLI) for the watcher to act
 * on. `claim` renames the file so two watchers can never execute the same one.
 * @param {string} dir
 * @returns {{ name: string, request: any }[]}
 */
export function pendingRequests(dir) {
  const requestDir = path.join(dir, 'control', 'requests')
  /** @type {{ name: string, request: any }[]} */
  const out = []
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(requestDir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return out
  }
  for (const name of names) {
    const request = readJson(path.join(requestDir, name), null)
    if (request) out.push({ name, request })
  }
  return out
}

/** @param {string} dir @param {string} name */
export function claimRequest(dir, name) {
  const requestDir = path.join(dir, 'control', 'requests')
  const claimed = `${name}.claimed`
  try {
    fs.renameSync(path.join(requestDir, name), path.join(requestDir, claimed))
    return true
  } catch {
    return false
  }
}

/** @param {string} dir */
export function pruneClaimed(dir) {
  const requestDir = path.join(dir, 'control', 'requests')
  try {
    for (const name of fs.readdirSync(requestDir)) {
      if (!name.endsWith('.claimed')) continue
      const full = path.join(requestDir, name)
      try {
        const stat = fs.statSync(full)
        if (Date.now() - stat.mtimeMs > 3600000) fs.rmSync(full, { force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} dir
 * @param {any} incident
 * @param {number} keep
 */
export function saveIncident(dir, incident, keep = 50) {
  const incidentDir = path.join(dir, 'incidents')
  ensureDir(incidentDir, 0o700)
  const name = `${String(incident.createdAt ?? Date.now())}-${String(incident.incident ?? 'unknown').replace(/[^a-z0-9-]/gi, '-')}.json`
  writeJsonAtomic(path.join(incidentDir, name), incident)
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(incidentDir).filter((entry) => entry.endsWith('.json')).sort()
  } catch {
    return name
  }
  for (const stale of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      fs.rmSync(path.join(incidentDir, stale), { force: true })
    } catch {
      /* ignore */
    }
  }
  return name
}

/** @param {string} dir @param {number} limit */
export function listIncidents(dir, limit = 20) {
  const incidentDir = path.join(dir, 'incidents')
  /** @type {any[]} */
  const out = []
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(incidentDir).filter((name) => name.endsWith('.json')).sort().reverse()
  } catch {
    return out
  }
  for (const name of names.slice(0, limit)) {
    const incident = readJson(path.join(incidentDir, name), null)
    if (incident) out.push(incident)
  }
  return out
}

/**
 * Deliveries that could not be sent while the host was down wait here and are
 * replayed by the host plugin on its next start.
 * @param {string} dir
 * @param {any} entry
 */
export function appendOutbox(dir, entry) {
  const outbox = path.join(dir, 'outbox')
  ensureDir(outbox, 0o700)
  // A dead host makes delivery queue every report; identical reports in the
  // last ten minutes are collapsed so a flapping guard cannot flood the channel
  // once the host comes back and replays the queue.
  try {
    const recent = fs
      .readdirSync(outbox)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(-40)
    for (const name of recent) {
      const existing = readJson(path.join(outbox, name), null)
      if (!existing) continue
      if (existing.event !== entry.event) continue
      if (existing.text !== entry.text) continue
      if (Math.abs(Number(entry.createdAt ?? Date.now()) - Number(existing.createdAt ?? 0)) > 10 * 60_000) continue
      return ''
    }
  } catch {
    /* best effort */
  }
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  writeJsonAtomic(path.join(outbox, name), entry)
  return name
}

/** @param {string} dir @param {number} hours */
export function pruneOutbox(dir, hours) {
  const outbox = path.join(dir, 'outbox')
  const cutoff = Date.now() - hours * 3600000
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(outbox)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const full = path.join(outbox, name)
    try {
      const stat = fs.statSync(full)
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(full, { force: true })
        removed += 1
      }
    } catch {
      /* ignore */
    }
  }
  return removed
}

/** @param {string} dir @returns {{ name: string, entry: any }[]} */
export function readOutbox(dir) {
  const outbox = path.join(dir, 'outbox')
  /** @type {{ name: string, entry: any }[]} */
  const out = []
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(outbox).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return out
  }
  for (const name of names) {
    const entry = readJson(path.join(outbox, name), null)
    if (entry) out.push({ name, entry })
  }
  return out
}

/** @param {string} dir @param {string} name */
export function dropOutbox(dir, name) {
  try {
    fs.rmSync(path.join(dir, 'outbox', name), { force: true })
  } catch {
    /* ignore */
  }
}

/**
 * Operator-facing markdown that mirrors the latest incident, so a person who
 * only has the filesystem can still see what happened.
 * @param {string} dir
 * @param {string} markdown
 */
export function writeAlert(dir, markdown) {
  const file = path.join(dir, 'ALERT.md')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, markdown, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
  return file
}
