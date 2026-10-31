// @ts-check
/**
 * Optional second opinion from an LLM when the rule-based ladder has run out
 * of safe moves.
 *
 * Boundaries are deliberate:
 * - off unless the operator enables it;
 * - only the redacted boot-log tail and already-public facts are sent;
 * - the model answers with a JSON verdict from a closed set, and that verdict
 *   is mapped onto the *existing* allow-listed actions — the guard never runs
 *   model output as a command.
 */

import { redactText, tailForReport } from './redact.js'
import { resolveModelKey } from './credentials.js'

/** @typedef {'retry'|'rollback-patch'|'wait'|'manual'} AiAction */

/**
 * @typedef {{
 *   action: AiAction,
 *   reason: string,
 *   hint: string,
 *   confidence: number,
 * }} AiVerdict
 */

export const AI_PRESETS = {
  deepseek: {
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
  },
  custom: {
    endpoint: '',
    model: '',
    keyEnv: 'DSH_RESTART_GUARD_AI_KEY',
  },
}

export const AI_ACTIONS = ['retry', 'rollback-patch', 'wait', 'manual']

/**
 * Resolve the effective AI settings. Key material is read from the process
 * environment and never persisted.
 *
 * @param {any} config
 * @param {Record<string, string | undefined>} env
 */
export function aiSettings(config, env = process.env) {
  const ai = (config && config.ai) || {}
  const presetName = AI_PRESETS[ai.preset] ? ai.preset : 'deepseek'
  const preset = AI_PRESETS[presetName]
  const keyEnv = typeof ai.keyEnv === 'string' && ai.keyEnv ? ai.keyEnv : preset.keyEnv
  const keyRef = typeof ai.keyRef === 'string' ? ai.keyRef : ''
  const credentialSource = ['auto', 'env', 'dsh', 'none'].includes(ai.credentialSource) ? ai.credentialSource : 'auto'
  const key = credentialSource === 'none'
    ? { apiKey: '', keySource: 'missing', keyName: keyRef || keyEnv, storePath: '', storeError: 'credentialSource=none' }
    : resolveModelKey({ keyRef, keyEnv, source: credentialSource, env })
  const bridgeEnabled = ai.bridge && ai.bridge.enabled === true && typeof ai.bridge.program === 'string' && ai.bridge.program !== ''
  return {
    enabled: ai.enabled === true,
    preset: presetName,
    endpoint: String(ai.endpoint || preset.endpoint || ''),
    model: String(ai.model || preset.model || ''),
    keyEnv,
    keyRef,
    credentialSource,
    apiKey: key.apiKey,
    keySource: key.keySource,
    keyName: key.keyName,
    storePath: key.storePath,
    bridge: {
      enabled: bridgeEnabled,
      program: bridgeEnabled ? String(ai.bridge.program) : '',
      args: bridgeEnabled && Array.isArray(ai.bridge.args) ? ai.bridge.args.map(String) : [],
    },
    timeoutMs: Number(ai.timeoutMs) > 0 ? Number(ai.timeoutMs) : 20000,
    maxLogBytes: Number(ai.maxLogBytes) > 0 ? Number(ai.maxLogBytes) : 8192,
  }
}

/**
 * Bulletproof instruction: closed verdict set, JSON only, no commands.
 *
 * @param {{ locale?: string, facts: Record<string, any>, logText?: string }} input
 */
export function buildAiRequest(input) {
  const zh = String(input.locale || 'en').toLowerCase().startsWith('zh')
  const logTail = tailForReport(redactText(String(input.logText || '')), 80, Number(input.facts.maxLogBytes) || 8192)
  const system = [
    'You are the diagnosis assistant of dsh-restart-guard, a watchdog for the DeepSeek Harness (DSH) web server.',
    'You receive a failed boot log tail and environment facts. Decide the single most useful next action.',
    'Answer with ONE JSON object and nothing else, using exactly these fields:',
    '{"action":"retry|rollback-patch|wait|manual","reason":"one short sentence","hint":"what the operator should check or do","confidence":0.0}',
    'Definitions:',
    '- retry: starting DSH again with the same argv is likely to work.',
    '- rollback-patch: the failure comes from the profile patch layer (cordis.patch.yml); rolling back to the newest valid backup is likely to work.',
    '- wait: something else is probably restarting DSH (upgrade, package manager, container restart); waiting is safer.',
    '- manual: a human must fix configuration, dependencies, permissions or the port holder.',
    'Never propose shell commands in fields other than "hint" prose.',
    zh ? 'Write "reason" and "hint" in Simplified Chinese.' : 'Write "reason" and "hint" in English.',
  ].join('\n')
  const facts = {
    incident: input.facts.incident,
    detail: input.facts.detail,
    evidence: input.facts.evidence,
    attempt: input.facts.attempt,
    maxAttempts: input.facts.maxAttempts,
    port: input.facts.port,
    profile: input.facts.profile,
    supervisor: input.facts.supervisor,
    maintenance: input.facts.maintenance,
    patchBackups: input.facts.patchBackups,
    node: input.facts.node,
    dshVersion: input.facts.dshVersion,
  }
  const user = `Facts:\n${JSON.stringify(facts, null, 2)}\n\nBoot log tail:\n${logTail || '(empty)'}`
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
}

/**
 * Tolerate code fences and prose around the object.
 * @param {string} text
 */
export function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

/**
 * @param {string} text
 * @returns {{ ok: true, verdict: AiVerdict } | { ok: false, error: string }}
 */
export function parseVerdict(text) {
  const parsed = extractJson(text)
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'reply is not a JSON object' }
  const action = String(parsed.action || '').trim()
  if (!AI_ACTIONS.includes(action)) return { ok: false, error: `action "${action}" is not in the allow-list` }
  const confidence = Number(parsed.confidence)
  return {
    ok: true,
    verdict: {
      action: /** @type {AiAction} */ (action),
      reason: String(parsed.reason || '').slice(0, 300),
      hint: String(parsed.hint || '').slice(0, 600),
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    },
  }
}

/**
 * One chat-completions call. Uses the global fetch of Node >= 22.
 *
 * @param {{
 *   settings: ReturnType<typeof aiSettings>,
 *   messages: Array<{role: string, content: string}>,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<{ ok: true, verdict: AiVerdict, raw: string } | { ok: false, error: string }>}
 */
/**
 * Ask an external program instead of an HTTP endpoint. This is the "bridge"
 * path: the operator points it at anything that turns prompt text on stdin into
 * an answer on stdout (for example a wrapper around `dsh headless`), which keeps
 * the second opinion available when the web server itself is down.
 *
 * @param {{ settings: any, messages: Array<{role: string, content: string}>, spawnImpl?: Function }} input
 * @returns {Promise<{ok: true, verdict: AiVerdict, raw: string} | {ok: false, error: string}>}
 */
export async function callBridge(input) {
  const { settings, messages } = input
  const spawnImpl = input.spawnImpl ?? (await import('node:child_process')).spawn
  const prompt = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n')
  return await new Promise((resolve) => {
    /** @type {any} */
    let child
    try {
      child = spawnImpl(settings.bridge.program, settings.bridge.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (/** @type {any} */ error) {
      resolve({ ok: false, error: `bridge failed to start: ${String(error?.message || error)}` })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve({ ok: false, error: `bridge timed out after ${settings.timeoutMs}ms` })
    }, settings.timeoutMs)
    const finish = (/** @type {any} */ result) => {
      clearTimeout(timer)
      resolve(result)
    }
    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      if (stdout.length < 200_000) stdout += chunk.toString()
    })
    child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString()
    })
    child.on('error', (/** @type {any} */ error) => finish({ ok: false, error: `bridge error: ${String(error?.message || error)}` }))
    child.on('close', (/** @type {number|null} */ code) => {
      if (code !== 0) {
        finish({ ok: false, error: `bridge exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}` })
        return
      }
      const parsed = parseVerdict(stdout)
      if (parsed.ok === false) finish({ ok: false, error: parsed.error })
      else finish({ ok: true, verdict: parsed.verdict, raw: stdout })
    })
    try {
      child.stdin?.end(prompt)
    } catch {
      /* the close/error handler reports the outcome */
    }
  })
}

export async function callAi(input) {
  const { settings, messages } = input
  if (!settings.enabled) return { ok: false, error: 'AI repair is disabled' }
  if (settings.bridge?.enabled) return await callBridge(input)
  if (!settings.endpoint) return { ok: false, error: 'no endpoint configured' }
  if (!settings.endpoint) return { ok: false, error: 'no endpoint configured' }
  if (!settings.apiKey) {
    const where = settings.keySource === 'missing' && settings.storePath ? ` (checked $${settings.keyName} and ${settings.storePath})` : ''
    return { ok: false, error: `no API key for ${settings.keyName}${where}` }
  }
  const doFetch = input.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: 'fetch is not available in this Node runtime' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  try {
    const res = await doFetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model: settings.model, messages, temperature: 0, stream: false }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
    }
    const data = /** @type {any} */ (await res.json().catch(() => null))
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') return { ok: false, error: 'reply did not contain choices[0].message.content' }
    const parsed = parseVerdict(content)
    if (parsed.ok === false) return { ok: false, error: parsed.error }
    return { ok: true, verdict: parsed.verdict, raw: content }
  } catch (/** @type {any} */ error) {
    const message = error && error.name === 'AbortError' ? `timed out after ${settings.timeoutMs}ms` : String(error?.message || error)
    return { ok: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Map a verdict onto the plan. Pure and conservative: hard stops are never
 * overridden, a foreign port holder is never restarted over, and an action
 * below 0.5 confidence is refused.
 *
 * @param {import('./plan.js').RepairPlan} plan
 * @param {AiVerdict} verdict
 * @param {{
 *   hasBackups?: boolean,
 *   attempt?: number,
 *   occupantIsForeign?: boolean,
 *   config?: any,
 * }} [options]
 * @returns {{ ok: boolean, applied: boolean, reason: string }}
 */
export function applyAiVerdict(plan, verdict, options = {}) {
  const opts = { hasBackups: false, attempt: 1, occupantIsForeign: false, ...options }
  const hardStops = ['maintenance', 'tree-incomplete', 'supervised', 'foreign-holder']
  if (hardStops.includes(plan.stopReason)) {
    return { ok: false, applied: false, reason: `AI may not override ${plan.stopReason}` }
  }
  if (opts.occupantIsForeign) {
    return { ok: false, applied: false, reason: 'the port is held by a non-DSH process' }
  }
  if (verdict.confidence < 0.5) {
    return { ok: false, applied: false, reason: `AI confidence ${verdict.confidence.toFixed(2)} is below 0.5` }
  }
  if (verdict.action === 'wait') {
    return { ok: false, applied: false, reason: verdict.reason || 'AI advised waiting' }
  }
  if (verdict.action === 'manual') {
    return { ok: false, applied: false, reason: verdict.reason || 'AI advised manual repair' }
  }

  const hasStart = plan.steps.some((item) => item.action === 'start-dsh')
  if (verdict.action === 'retry') {
    if (hasStart) return { ok: true, applied: false, reason: 'the rule-based plan already restarts DSH' }
    plan.steps = plan.steps.filter((item) => item.action !== 'manual')
    plan.steps.push({
      id: 'ai-start',
      action: 'start-dsh',
      status: 'pending',
      detail: 'AI verdict: retry with the captured launch spec',
    })
    plan.steps.push({
      id: 'ai-verify',
      action: 'verify',
      status: 'pending',
      detail: 'AI verdict: wait for the access line and re-probe the port',
    })
    plan.stopReason = 'ai-retry'
    return { ok: true, applied: true, reason: 'AI added a restart attempt' }
  }

  // rollback-patch
  if (plan.steps.some((item) => item.action === 'rollback-patch')) {
    return { ok: true, applied: false, reason: 'the rule-based plan already rolls the patch back' }
  }
  if (!opts.hasBackups) return { ok: false, applied: false, reason: 'no cordis.patch.yml backup to roll back to' }
  if (opts.attempt > 1) return { ok: false, applied: false, reason: 'a rollback was already attempted for this incident' }
  plan.steps = plan.steps.filter((item) => item.action !== 'manual')
  plan.steps.unshift({
    id: 'ai-rollback',
    action: 'rollback-patch',
    status: 'pending',
    detail: 'AI verdict: roll back to the newest valid patch backup, then restart',
  })
  if (!hasStart) {
    plan.steps.push({
      id: 'ai-start',
      action: 'start-dsh',
      status: 'pending',
      detail: 'AI verdict: start DSH after the rollback',
    })
    plan.steps.push({
      id: 'ai-verify',
      action: 'verify',
      status: 'pending',
      detail: 'AI verdict: wait for the access line and re-probe the port',
    })
  }
  plan.stopReason = 'ai-rollback'
  return { ok: true, applied: true, reason: 'AI added a patch rollback attempt' }
}
