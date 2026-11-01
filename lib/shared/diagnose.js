// @ts-check
/**
 * Boot-failure classification.
 *
 * The watch loop only ever sees the *new bytes* a spawn appended to the boot
 * log, so every verdict here is about one boot attempt. Patterns are ordered:
 * the first match wins, because a YAML error also prints a stack trace that
 * could otherwise be mistaken for a generic crash.
 */
import fs from 'node:fs'

/**
 * @typedef {{
 *   incident: string,
 *   detail: string,
 *   evidence: string[],
 *   entryId?: string,
 *   entryName?: string,
 *   required?: boolean,
 *   failedPlugins?: Array<{ id: string, package: string, required: boolean, detail: string }>,
 *   unresolved: string[],
 *   inactive: string[],
 * }} Diagnosis
 */

/** @type {ReadonlyArray<{ incident: string, pattern: RegExp, detail: string }>} */
const RULES = [
  {
    incident: 'yaml-config',
    pattern: /YAMLException|bad indentation of a mapping entry|duplicated mapping key|unknown tag|unexpected end of the stream|cannot unmarshal|failed to parse .*yaml/i,
    detail: 'the profile patch or a config file failed to parse',
  },
  {
    incident: 'wildcard-host',
    pattern: /unspecified \(wildcard\) address|host\s+"?0\.0\.0\.0"?\s+is an unspecified/i,
    detail: 'the web server was asked to bind a wildcard address',
  },
  {
    incident: 'port-in-use',
    pattern: /EADDRINUSE|address already in use/i,
    detail: 'the web port is served by another process',
  },
  {
    incident: 'module-missing',
    pattern: /ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND/i,
    detail: 'a dependency could not be resolved',
  },
  {
    incident: 'permission-disk-memory',
    pattern: /EACCES|EPERM|ENOSPC|EDQUOT|EROFS|ENOMEM|heap out of memory/i,
    detail: 'the process hit a permission, disk or memory limit',
  },
  {
    incident: 'crash',
    pattern: /Segmentation fault|FATAL ERROR|Unhandled 'error' event|uncaughtException|ERR_WORKER_OUT_OF_MEMORY/i,
    detail: 'the process crashed before serving',
  },
  {
    incident: 'startup-failed',
    pattern: /startup failed|StartupError/i,
    detail: 'DSH reported a startup failure',
  },
  {
    incident: 'plugin-failed',
    pattern: /plugin\(s\) failed to load:|did not activate|failed to mount/i,
    detail: 'one or more profile plugins failed to activate',
  },
  {
    incident: 'patch-incompatible',
    pattern: /without inject|failed to apply loader entry|disabling profile plugin|patch: entry .* not found/i,
    detail: 'the profile patch references a row or service this DSH version does not provide',
  },
]

/**
 * Read the bytes a spawn appended, bounded from both sides.
 * @param {string} logPath
 * @param {number} fromOffset byte offset where the attempt's output starts
 * @param {number} maxBytes
 * @returns {{ text: string, size: number, truncated: boolean }}
 */
export function readLogSegment(logPath, fromOffset, maxBytes = 1048576) {
  /** @type {number} */
  let size = 0
  try {
    size = fs.statSync(logPath).size
  } catch {
    return { text: '', size: 0, truncated: false }
  }
  const start = Math.max(0, Math.min(fromOffset, size))
  const end = size
  if (end <= start) return { text: '', size, truncated: false }
  const length = end - start
  const readLength = Math.min(length, maxBytes)
  const truncated = readLength < length
  const buffer = Buffer.allocUnsafe(readLength)
  try {
    const fd = fs.openSync(logPath, 'r')
    try {
      fs.readSync(fd, buffer, 0, readLength, end - readLength)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { text: '', size, truncated }
  }
  return { text: buffer.toString('utf8'), size, truncated }
}

/**
 * Read the tail of a log that the guard did not spawn itself (the host's own
 * run), without loading a multi-gigabyte file.
 * @param {string} logPath
 * @param {number} [maxBytes]
 */
export function tailSegment(logPath, maxBytes = 1048576) {
  /** @type {number} */
  let size = 0
  try {
    size = fs.statSync(logPath).size
  } catch {
    return { text: '', size: 0, offset: 0 }
  }
  const offset = Math.max(0, size - maxBytes)
  return { ...readLogSegment(logPath, offset, maxBytes), offset }
}

/**
 * @param {string} text
 * @returns {Diagnosis}
 */
export function parseBootFailure(text) {
  const clean = String(text ?? '')
  /** @type {string[]} */
  const lines = clean.split('\n')
  for (const rule of RULES) {
    if (!rule.pattern.test(clean)) continue
    const evidence = lines.filter((line) => rule.pattern.test(line)).slice(-3)
    return {
      incident: rule.incident,
      detail: rule.detail,
      evidence: evidence.length > 0 ? evidence : firstMeaningful(lines),
      ...parseLoaderDetails(clean),
    }
  }
  return {
    incident: 'unknown',
    detail: 'the process exited without a recognised error',
    evidence: firstMeaningful(lines),
    ...parseLoaderDetails(clean),
  }
}

/**
 * @param {string[]} lines
 */
function firstMeaningful(lines) {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^at\s/.test(line) && !/^\[?\d+m?$/.test(line))
    .slice(-3)
}

/**
 * dshmarket's recovery parser, re-implemented here so the guard does not depend
 * on that package being installed. Marker order matters: the last marker in the
 * output is the one that matches the current boot.
 * @param {string} text
 */
export function parseLoaderDetails(text) {
  /** @type {{ entryId?: string, entryName?: string, required?: boolean, failedPlugins?: Array<{ id: string, package: string, required: boolean, detail: string }>, unresolved: string[], inactive: string[] }} */
  const out = { unresolved: [], inactive: [] }
  const markers = [
    /plugin\(s\) failed to load:/,
    /\d+ entr(?:y|ies) did not activate/,
    /failed to apply loader entry [^\s(]+ \([^)]+\):/,
  ]
  let best = -1
  for (const marker of markers) {
    let match
    const global = new RegExp(marker.source, 'g')
    while ((match = global.exec(text)) !== null) best = Math.max(best, match.index)
  }
  const tail = best >= 0 ? text.slice(best) : text
  const entry = /failed to apply loader entry ([^\s(]+) \(([^)]+)\):\s*([^\n]*)/.exec(tail)
  if (entry) {
    out.entryId = entry[1]
    out.entryName = entry[2]
  }
  // DSH's startupDiagnostic prints a block for required plugins that did not
  // activate: the id on an indented line, the package on the next, plus the
  // failing phase. This is what names the plugin the AI has to repair.
  const block = /Failed plugins \(\d+\):\s*\n([\s\S]*)$/.exec(tail)
  if (block) {
    const lines = block[1].split('\n')
    /** @type {Array<{ id: string, package: string, required: boolean, detail: string }>} */
    const failed = []
    /** @type {{ id: string, required: boolean, package: string, detail: string } | null} */
    let current = null
    for (const line of lines) {
      const head = /^\s{2}(\S+)(?:\s+\((required|optional)\))?\s*$/.exec(line)
      if (head && !head[1].endsWith(':')) {
        if (current) failed.push(current)
        current = { id: head[1], package: '', required: head[2] === 'required', detail: '' }
        continue
      }
      if (!current) continue
      const pkg = /^\s+Package:\s*(\S+)\s*$/.exec(line)
      if (pkg) {
        current.package = pkg[1]
        continue
      }
      const detail = /^\s{2,}([A-Za-z_][A-Za-z0-9_ ]*):\s*(.+)$/.exec(line)
      if (detail && !current.detail) {
        current.detail = `${detail[1]}: ${detail[2]}`
        continue
      }
      if (/^\S/.test(line)) break
    }
    if (current) failed.push(current)
    out.failedPlugins = failed.filter((item) => item.id && item.package)
    if (out.failedPlugins.length > 0 && !out.entryId) {
      out.entryId = out.failedPlugins[0].id
      out.entryName = out.failedPlugins[0].package
      out.required = out.failedPlugins[0].required
    }
  }
  const activation = /^\s*(\S+) \(([^)]+)\):\s*(\S.*)$/m.exec(tail)
  if (activation && !out.entryId && !/^\[/.test(activation[1])) {
    out.entryId = activation[1]
    out.entryName = activation[2]
  }
  const unresolved = /plugin\(s\) failed to load:\s*([^\n]+)/.exec(tail)
  if (unresolved) {
    out.unresolved = unresolved[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  }
  const inactiveBlock = /\d+ entr(?:y|ies) did not activate[^\n]*\n([\s\S]*)$/.exec(tail)
  if (inactiveBlock) {
    for (const line of inactiveBlock[1].split('\n')) {
      if (/^\s/.test(line)) continue
      const match = /^(\S.*?):\s+(\S.*)$/.exec(line)
      if (!match) continue
      if (/^\[|^dsh:\s/.test(line)) continue
      out.inactive.push(`${match[1]}: ${match[2]}`)
    }
  }
  return out
}

/**
 * The access line DSH prints once the server is listening. Only lines *after*
 * the spawn offset are considered, which is what keeps a previous boot's line
 * from faking readiness.
 * @param {string} text
 * @param {string} accessLine
 */
export function parseAccessLine(text, accessLine = 'dsh web:') {
  const lines = String(text ?? '').split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.includes(accessLine)) continue
    return { found: true, line: line.trim(), hasToken: /\btoken=/.test(line) }
  }
  return { found: false, line: '', hasToken: false }
}

/**
 * @param {string} text
 * @param {readonly string[]} patterns
 */
export function bootAudit(text, patterns) {
  const clean = String(text ?? '')
  /** @type {{ pattern: string, line: string }[]} */
  const hits = []
  for (const pattern of patterns) {
    /** @type {RegExp} */
    let re
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      continue
    }
    for (const line of clean.split('\n')) {
      if (re.test(line)) hits.push({ pattern, line: line.trim() })
    }
  }
  return { hits, fatal: hits.length > 0 }
}

/**
 * Short stable key for "the same failure happened again" detection.
 * @param {Diagnosis} diagnosis
 */
export function failureFingerprint(diagnosis) {
  return [diagnosis.incident, diagnosis.entryId ?? '', diagnosis.entryName ?? '', (diagnosis.unresolved ?? []).join(',')]
    .filter(Boolean)
    .join('|')
}
