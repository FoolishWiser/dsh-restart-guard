// @ts-check
/**
 * Look up what dsh-im already knows, so the operator can pick a bot and a
 * target from the settings page instead of copying identifiers by hand.
 * Everything here is read-only and best effort: a channel that is still booting
 * simply returns fewer rows.
 */

/**
 * @param {any} service dsh-im host service (`ctx.get('dshIm')`)
 * @returns {Promise<{ available: boolean, reason: string, bots: Array<{botId: string, channel: string, connected: boolean}>, targets: Record<string, any[]> }>}
 */
export async function listIm(service) {
  if (!service) return { available: false, reason: 'dsh-im is not installed', bots: [], targets: {} }
  /** @type {any[]} */
  let bots = []
  try {
    const listed = await service.listBots()
    bots = Array.isArray(listed) ? listed : []
  } catch (error) {
    return {
      available: true,
      reason: `listBots failed: ${error instanceof Error ? error.message : String(error)}`,
      bots: [],
      targets: {},
    }
  }
  /** @type {Record<string, any[]>} */
  const targets = {}
  for (const bot of bots.slice(0, 5)) {
    const botId = String(bot?.botId ?? bot?.id ?? '')
    if (!botId) continue
    try {
      const listed = await service.listTargets(botId)
      const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.targets) ? listed.targets : []
      targets[botId] = rows.slice(0, 50)
    } catch {
      targets[botId] = []
    }
  }
  return {
    available: true,
    reason: '',
    bots: bots
      .map((bot) => ({
        botId: String(bot?.botId ?? bot?.id ?? ''),
        channel: String(bot?.channel ?? ''),
        connected: Boolean(bot?.connected),
      }))
      .filter((bot) => bot.botId),
    targets,
  }
}

/**
 * QQ and the other channels only expose a bot id until a delivery target has
 * been created, so delivery may run with an empty target: accept it when the
 * bot has exactly one saved target, and say precisely what to do otherwise.
 *
 * @param {any[]} targets rows from `service.listTargets(botId)`
 * @param {string} [targetId]
 * @returns {{ ok: boolean, targetId: string, candidates: string[], reason: string }}
 */
export function pickTarget(targets, targetId = '') {
  const ids = (Array.isArray(targets) ? targets : [])
    .map((row) => String(row?.targetId ?? row?.id ?? ''))
    .filter(Boolean)
  if (targetId) return { ok: true, targetId, candidates: ids, reason: '' }
  if (ids.length === 1) return { ok: true, targetId: ids[0], candidates: ids, reason: `using the only saved target ${ids[0]}` }
  if (ids.length > 1) {
    return {
      ok: false,
      targetId: '',
      candidates: ids,
      reason: `bot has ${ids.length} saved targets (${ids.slice(0, 5).join(', ')}); set notify.im.targetId`,
    }
  }
  return {
    ok: false,
    targetId: '',
    candidates: [],
    reason: 'this bot has no delivery target yet. For QQ, message the bot once (or create a target in Settings → IM bot) and then pick it here; botId alone is not enough to send proactively.',
  }
}

/**
 * Resolve a target id for delivery, reading dsh-im when the caller left it empty.
 *
 * @param {any} service
 * @param {{ botId: string, targetId?: string }} input
 * @returns {Promise<{ ok: boolean, targetId: string, candidates: string[], reason: string }>}
 */
export async function resolveImTarget(service, input) {
  if (input.targetId) return { ok: true, targetId: input.targetId, candidates: [], reason: '' }
  if (!service || !input.botId) {
    return { ok: false, targetId: '', candidates: [], reason: 'dsh-im is not available or botId is empty' }
  }
  /** @type {any[]} */
  let rows = []
  try {
    const listed = await service.listTargets(input.botId)
    rows = Array.isArray(listed) ? listed : Array.isArray(listed?.targets) ? listed.targets : []
  } catch (error) {
    return {
      ok: false,
      targetId: '',
      candidates: [],
      reason: `listTargets failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return pickTarget(rows, '')
}
