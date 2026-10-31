// @ts-check
/**
 * Read the harness credential store so the guard can talk to the same model
 * provider as `dsh` itself while `dsh web` is down.
 *
 * The store is a small YAML document:
 *
 *   version: 1
 *   refs:
 *     DEEPSEEK_API_KEY: sk-...
 *   records:
 *     ...
 *
 * Only the `refs` map is needed. Values are never logged, never persisted by
 * the guard and never sent anywhere except to the configured AI endpoint.
 */

import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from './paths.js'

/** @returns {string} */
export function credentialsPath(env = process.env) {
  return path.join(dshHome(env), '.credentials.yaml')
}

/**
 * Minimal parser for the `refs:` block of the harness credential file.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseCredentialRefs(text) {
  /** @type {Record<string, string>} */
  const refs = {}
  let inRefs = false
  let refsIndent = -1
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (!inRefs) {
      if (line === 'refs:' || line.startsWith('refs: ')) {
        inRefs = true
        refsIndent = -1
      }
      continue
    }
    // A new top-level key ends the block.
    if (indent === 0 && !line.startsWith('refs:')) break
    if (refsIndent < 0) refsIndent = indent
    if (indent < refsIndent) break
    if (indent !== refsIndent) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    let key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (!key) continue
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1)
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    if (key && value) refs[key] = value
  }
  return refs
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ refs: Record<string, string>, path: string, exists: boolean, error: string }}
 */
export function readDshCredentials(env = process.env) {
  const file = credentialsPath(env)
  try {
    const text = fs.readFileSync(file, 'utf8')
    return { refs: parseCredentialRefs(text), path: file, exists: true, error: '' }
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    return { refs: {}, path: file, exists: false, error: code === 'ENOENT' ? 'not found' : String(code) }
  }
}

/** Names the guard is willing to borrow, in preference order. */
export const MODEL_KEY_REFS = ['DEEPSEEK_API_KEY', 'XIAOMI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']

/**
 * Pick a model credential: an explicit reference first, then the preset's own
 * variable, then any well-known provider key already in the harness store.
 *
 * @param {{ keyRef?: string, keyEnv?: string, source?: string, env?: Record<string, string | undefined>, read?: typeof readDshCredentials }} input
 * @returns {{ apiKey: string, keySource: 'env'|'dsh-store'|'missing', keyName: string, storePath: string, storeError: string }}
 */
export function resolveModelKey(input = {}) {
  const env = input.env || process.env
  const source = input.source || 'auto'
  const names = [input.keyRef, input.keyEnv, ...MODEL_KEY_REFS].filter((name) => typeof name === 'string' && name)
  const store = source === 'env' ? null : (input.read || readDshCredentials)(env)
  const storeRefs = store ? store.refs : {}

  if (source !== 'dsh') {
    for (const name of names) {
      const value = env[name] || (name === 'DSH_RESTART_GUARD_AI_KEY' ? env.DSH_RESTART_GUARD_AI_KEY : '')
      if (value) return { apiKey: String(value), keySource: 'env', keyName: name, storePath: store?.path ?? '', storeError: '' }
    }
  }
  if (source !== 'env') {
    for (const name of names) {
      const value = storeRefs[name]
      if (value) {
        return { apiKey: String(value), keySource: 'dsh-store', keyName: name, storePath: store?.path ?? '', storeError: '' }
      }
    }
  }
  return {
    apiKey: '',
    keySource: 'missing',
    keyName: names[0] || '',
    storePath: store?.path ?? '',
    storeError: store?.error ?? '',
  }
}
