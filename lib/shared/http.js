// @ts-check
/**
 * Minimal HTTP plumbing for the host routes. No framework, no dependency: the
 * guard must not add any runtime package to somebody's profile.
 */
import crypto from 'node:crypto'

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<{ ok: boolean, value?: any, status?: number, error?: string }>}
 */
export function readJson(req, limit = 65536) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > limit) {
      resolve({ ok: false, status: 413, error: 'payload too large' })
      req.resume()
      return
    }
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        settle({ ok: false, status: 413, error: 'payload too large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) return settle({ ok: false, status: 400, error: 'empty body' })
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settle({ ok: true, value })
      } catch {
        settle({ ok: false, status: 400, error: 'invalid json' })
      }
    })
    req.on('error', () => settle({ ok: false, status: 400, error: 'request error' }))
  })
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
export function sendJson(res, status, value) {
  const body = JSON.stringify(value ?? null)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 */
export function sendText(res, status, text) {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** @returns {string} */
export function newToken() {
  return crypto.randomBytes(24).toString('base64url')
}

/**
 * Constant-time comparison; both sides are hashed first so different lengths
 * cannot leak through timing.
 * @param {string} a
 * @param {string} b
 */
export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false
  const left = crypto.createHash('sha256').update(a).digest()
  const right = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(left, right)
}

/**
 * The meta tag the web client reads. Injected through `tapIndex`, which means
 * it is only rendered inside an authenticated page — an unauthenticated caller
 * never sees it.
 * @param {string} token
 */
export function metaTag(token) {
  return `<meta name="dsh-restart-guard-token" content="${token}" />`
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} token
 */
export function authorized(req, token) {
  const header = req.headers['x-restart-guard-token']
  const value = Array.isArray(header) ? header[0] : header
  return sameToken(String(value ?? ''), token)
}
