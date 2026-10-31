// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { appendOutbox } from '../lib/shared/state.js'
import { tmpHome } from './helpers.mjs'

test('appendOutbox collapses identical reports inside ten minutes', () => {
  const dir = tmpHome()
  const entry = { channel: 'im', botId: 'b', targetId: '', text: 'same text', event: 'maintenance', createdAt: Date.now() }
  const first = appendOutbox(dir, entry)
  assert.ok(first, 'the first report is queued')
  const second = appendOutbox(dir, { ...entry, createdAt: Date.now() })
  assert.equal(second, '', 'the duplicate is dropped')
  assert.equal(fs.readdirSync(path.join(dir, 'outbox')).filter((n) => n.endsWith('.json')).length, 1)

  const otherEvent = appendOutbox(dir, { ...entry, event: 'down', text: 'same text' })
  assert.ok(otherEvent, 'a different event is queued')
  const otherText = appendOutbox(dir, { ...entry, createdAt: Date.now() + 11 * 60_000 })
  assert.ok(otherText, 'the same text after ten minutes is queued again')
})
