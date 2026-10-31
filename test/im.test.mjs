// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import { listIm , pickTarget, resolveImTarget } from '../lib/shared/im.js'

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

test('pickTarget accepts botId-only when the bot has exactly one target', () => {
  const one = pickTarget([{ targetId: 'tgt_aaa', channel: 'qq' }])
  assert.equal(one.ok, true)
  assert.equal(one.targetId, 'tgt_aaa')
  assert.match(one.reason, /only saved target/)

  const none = pickTarget([], '')
  assert.equal(none.ok, false)
  assert.match(none.reason, /QQ/)

  const many = pickTarget([{ targetId: 'a' }, { targetId: 'b' }])
  assert.equal(many.ok, false)
  assert.deepEqual(many.candidates, ['a', 'b'])

  assert.equal(pickTarget([{ targetId: 'a' }], 'explicit').targetId, 'explicit')
})

test('resolveImTarget reads dsh-im when the operator only has a bot id', async () => {
  const service = {
    listTargets: async (botId) => (botId === 'bot_qq' ? [{ targetId: 'tgt_qq' }] : []),
  }
  const ok = await resolveImTarget(service, { botId: 'bot_qq' })
  assert.equal(ok.ok, true)
  assert.equal(ok.targetId, 'tgt_qq')

  const missing = await resolveImTarget(service, { botId: 'bot_other' })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /no delivery target/)

  const offline = await resolveImTarget(null, { botId: 'bot_qq' })
  assert.equal(offline.ok, false)
})
