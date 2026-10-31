// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createLogger } from '../lib/shared/log.js'

test('mirrors guard lines into the host stdout file for docker logs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-log-'))
  const guard = path.join(dir, 'guard.log')
  const host = path.join(dir, 'web.log')
  fs.writeFileSync(host, 'dsh web: http://127.0.0.1:3079/?token=abc\n')
  const logger = createLogger({ file: guard, mirror: host, secrets: () => [] })
  logger.info('down', 'port 3079 refused')
  const hostText = fs.readFileSync(host, 'utf8')
  const guardText = fs.readFileSync(guard, 'utf8')
  assert.match(hostText, /^dsh web: http:\/\/127\.0\.0\.1:3079\/\?token=abc\n\[dsh-restart-guard\] /)
  assert.match(hostText, /INFO {2}down port 3079 refused/)
  assert.match(guardText, /INFO {2}down port 3079 refused/)
})

test('a missing mirror target never breaks logging', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-log-'))
  const logger = createLogger({ file: path.join(dir, 'guard.log'), mirror: () => path.join(dir, 'nope', 'web.log') })
  logger.warn('probe', 'still fine')
  assert.match(fs.readFileSync(path.join(dir, 'guard.log'), 'utf8'), /still fine/)
})
