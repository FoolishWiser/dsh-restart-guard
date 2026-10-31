// @ts-check
/**
 * Append-only guard log with size-based rotation. Every line is redacted before
 * it is written, and the file is opened with O_NOFOLLOW so a planted symlink
 * cannot redirect the write.
 */
import fs from 'node:fs'
import { openAppendNoFollow, statSafe } from './paths.js'
import { redactText, stripAnsi } from './redact.js'

/**
 * @typedef {{ info: (event: string, message?: string, data?: unknown) => void,
 *   warn: (event: string, message?: string, data?: unknown) => void,
 *   error: (event: string, message?: string, data?: unknown) => void,
 *   line: (level: string, event: string, message?: string, data?: unknown) => void,
 *   path: string }} Logger
 */

/** @param {Date} date */
function stamp(date) {
  return date.toISOString().replace('T', ' ').replace('Z', 'Z')
}

/**
 * @param {{ file: string, maxBytes?: number, keep?: number, secrets?: () => Iterable<string>,
 *   mirror?: string | null | (() => string | null) }} options
 * @returns {Logger}
 */
export function createLogger({ file, maxBytes = 5 * 1024 * 1024, keep = 2, secrets = () => [], mirror = null }) {
  /** @type {number | null} */
  let fd = null

  function rotateIfNeeded() {
    const stat = statSafe(file)
    if (!stat || stat.size < maxBytes) return
    try {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* ignore */
        }
        fd = null
      }
    } catch {
      /* ignore */
    }
    // file.1 is the newest backup; delete the oldest first.
    try {
      fs.rmSync(`${file}.${keep}`, { force: true })
    } catch {
      /* ignore */
    }
    for (let index = keep - 1; index >= 1; index -= 1) {
      try {
        fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`)
      } catch {
        /* ignore */
      }
    }
    try {
      fs.renameSync(file, `${file}.1`)
    } catch {
      /* ignore */
    }
  }

  /** @param {string} text */
  function write(text) {
    rotateIfNeeded()
    const line = `${redactText(stripAnsi(text), { secrets: secrets() })}\n`
    try {
      if (fd === null) fd = openAppendNoFollow(file)
      fs.writeSync(fd, line)
    } catch (error) {
      // Last resort: stderr, which the watcher was spawned with.
      try {
        process.stderr.write(line)
      } catch {
        /* ignore */
      }
      void error
    }
    mirrorLine(line)
  }

  /**
   * Echo the same line into the host's stdout stream, which is what a container
   * runtime captures as `docker logs`. Best effort: an unwritable target never
   * breaks the guard.
   *
   * @param {string} line
   */
  function mirrorLine(line) {
    let target = null
    try {
      target = typeof mirror === 'function' ? mirror() : mirror
    } catch {
      target = null
    }
    if (!target) return
    try {
      const fd2 = openAppendNoFollow(target)
      try {
        fs.writeSync(fd2, `[dsh-restart-guard] ${line}`)
      } finally {
        fs.closeSync(fd2)
      }
    } catch {
      /* ignore */
    }
  }

  /** @param {unknown} data */
  function formatData(data) {
    if (data === undefined || data === null) return ''
    try {
      return typeof data === 'string' ? ` ${data}` : ` ${JSON.stringify(data)}`
    } catch {
      return ''
    }
  }

  return {
    path: file,
    line(level, event, message, data) {
      write(`${stamp(new Date())} ${level.toUpperCase().padEnd(5)} ${event}${message ? ` ${message}` : ''}${formatData(data)}`)
    },
    info(event, message, data) {
      this.line('info', event, message, data)
    },
    warn(event, message, data) {
      this.line('warn', event, message, data)
    },
    error(event, message, data) {
      this.line('error', event, message, data)
    },
  }
}
