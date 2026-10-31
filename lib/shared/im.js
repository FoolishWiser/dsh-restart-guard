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
