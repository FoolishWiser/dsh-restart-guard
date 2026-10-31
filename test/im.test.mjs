// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import { listIm } from '../lib/shared/im.js'

test('lists bots and their targets', async () => {
  const service = {
    async listBots() {
      return [
        { botId: 'b1', channel: 'telegram', connected: true },
        { id: 'b2', channel: 'feishu', connected: false },
      ]
    },
    async listTargets(botId) {
      return botId === 'b1' ? [{ targetId: 'release-alerts', name: 'Release alerts' }] : { targets: [{ targetId: 'ops' }] }
    },
  }
  const info = await listIm(service)
  assert.equal(info.available, true)
  assert.deepEqual(info.bots.map((bot) => bot.botId), ['b1', 'b2'])
  assert.equal(info.bots[1].connected, false)
  assert.equal(info.targets.b1[0].targetId, 'release-alerts')
  assert.equal(info.targets.b2[0].targetId, 'ops')
})

test('degrades to a reason instead of throwing', async () => {
  assert.equal((await listIm(null)).available, false)
  const failing = { async listBots() { throw new Error('channel still booting') } }
  const info = await listIm(failing)
  assert.equal(info.available, true)
  assert.match(info.reason, /channel still booting/)
  assert.deepEqual(info.bots, [])
})
