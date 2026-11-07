// @ts-check
/**
 * A boot that prints the access line and then never answers HTTP is hanging,
 * not dead. verifyBoot must say so instead of timing out, because the timeout
 * path kills the process and starts a duplicate that dies with EADDRINUSE.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { normalizeConfig } from '../lib/shared/config.js'
import { verifyBoot } from '../lib/repair.js'
import { fakeDsh, freePort, tmpHome } from './helpers.mjs'

test('a boot that hangs on HTTP reports http-hanging', { timeout: 40000 }, async () => {
  const home = tmpHome()
  const port = await freePort(3998)
  const logPath = path.join(home, 'boot.log')
  const fd = fs.openSync(logPath, 'a')
  const child = spawn(process.execPath, [fakeDsh, 'web', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: home, FAKE_DSH_MODE: 'hang', FAKE_DSH_ACCESS: '1' },
    stdio: ['ignore', fd, fd],
  })
  fs.closeSync(fd)
  try {
    const started = Date.now()
    while (Date.now() - started < 8000) {
      if (fs.readFileSync(logPath, 'utf8').includes('dsh web: http')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const { config } = normalizeConfig({
      watchdog: { bootTimeoutMs: 20000, settleMs: 100, hangConfirmMs: 5000, probeIntervalMs: 500 },
    })
    const result = await verifyBoot({ child, logPath, offset: 0, config, port })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'http-hanging')
    assert.match(result.note ?? '', /accepts TCP but HTTP did not answer/)
    assert.ok(result.elapsedMs < 20000, 'reported before the boot timeout')
  } finally {
    child.kill('SIGKILL')
  }
})
