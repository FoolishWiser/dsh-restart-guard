// @ts-check
/**
 * End-to-end boot verification against a stand-in `dsh web`:
 * spawn → access line at the right byte offset → settle → healthy probe.
 * These tests run real child processes, so they are the closest thing to the
 * crash drill without touching a live DSH.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { DEFAULTS } from '../../lib/shared/config.js'
import { loadLaunchSpec } from '../../lib/shared/launch.js'
import { instanceDir } from '../../lib/shared/paths.js'
import { findOccupant, patchBackups, rollbackProfilePatch, spawnDsh, verifyBoot } from '../../lib/repair.js'
import { freePort, fakeTree, profileDir, tmpHome, waitFor, writeFakeLaunch } from '../helpers.mjs'

const PORT_BASE = 3910

/** @param {number} port @returns {any} */
function watchdog(port) {
  return {
    ...DEFAULTS,
    watchdog: { ...DEFAULTS.watchdog, bootTimeoutMs: 15000, settleMs: 100, startupGraceMs: 0, probeIntervalMs: 100 },
  }
}

/**
 * @param {{ mode?: string, counter?: string }} [input]
 */
async function fixture(input = {}) {
  const home = tmpHome()
  const port = await freePort(PORT_BASE)
  const logPath = path.join(home, 'boot.log')
  const dir = instanceDir({ DSH_HOME: home }, 'web', port)
  fs.mkdirSync(dir, { recursive: true })
  profileDir(home, 'web')
  const tree = fakeTree(home)
  writeFakeLaunch(dir, {
    port,
    logPath,
    mode: input.mode ?? 'ok',
    counter: input.counter ?? '',
    binPath: tree.binPath,
    pkgRoot: tree.pkgRoot,
  })
  const spec = loadLaunchSpec(dir)
  assert.ok(spec, 'launch spec written')
  return { home, port, logPath, dir, spec }
}

test('a healthy boot is verified from the access line of this attempt only', async () => {
  const { port, logPath, spec } = await fixture()
  fs.writeFileSync(logPath, 'dsh web: http://127.0.0.1:1/?token=stale-token-123456\n')
  const spawn = spawnDsh({ spec, logPath, port, attempt: 1 })
  assert.equal(spawn.ok, true)
  try {
    const result = await verifyBoot({
      child: spawn.child,
      logPath,
      offset: spawn.offset,
      config: watchdog(port),
      port,
      startedAt: Date.now(),
    })
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.reason, 'ready')
    assert.match(fs.readFileSync(logPath, 'utf8'), /token=test-token-/)
    assert.doesNotMatch(fs.readFileSync(logPath, 'utf8').slice(spawn.offset), /stale-token/)
  } finally {
    spawn.child.kill('SIGTERM')
  }
})

test('a crashing boot fails verification with the log tail', async () => {
  const { port, logPath, spec } = await fixture({ mode: 'fail' })
  const spawn = spawnDsh({ spec, logPath, port, attempt: 1 })
  assert.equal(spawn.ok, true)
  const result = await verifyBoot({
    child: spawn.child,
    logPath,
    offset: spawn.offset,
    config: watchdog(port),
    port,
    startedAt: Date.now(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'exit')
  assert.match(result.segment, /YAMLException/)
})

test('a silent server is only accepted after the inferred settle window', async () => {
  const { port, logPath, spec } = await fixture({ mode: 'silent' })
  const config = watchdog(port)
  config.watchdog.bootTimeoutMs = 4000
  config.readiness.inferredSettleMs = 1000
  config.readiness.inferredQuietMs = 500
  const spawn = spawnDsh({ spec, logPath, port, attempt: 1 })
  try {
    const result = await verifyBoot({
      child: spawn.child,
      logPath,
      offset: spawn.offset,
      config,
      port,
      startedAt: Date.now(),
    })
    assert.equal(result.ok, true)
    assert.equal(result.reason, 'ready-without-access-line')
    assert.equal(result.hasToken, false)
    assert.match(result.note, /fresh launch token/)
  } finally {
    spawn.child.kill('SIGTERM')
  }
})

test('an external listener is reported as a foreign holder, not killed', async () => {
  const { port } = await fixture()
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>not dsh</html>')
  })
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(null)))
  try {
    const occupant = findOccupant(port)
    assert.deepEqual(occupant.pids, [process.pid])
    assert.equal(occupant.isDsh, false)
  } finally {
    srv.close()
  }
})

test('the patch rollback keeps the broken file and applies a backup that composes', async () => {
  const home = tmpHome()
  const profile = 'web'
  const dir = profileDir(home, profile)
  const { binPath, pkgRoot } = fakeTree(home)
  // A stand-in `dsh --dump-config` that only accepts patches without BAD.
  fs.writeFileSync(
    path.join(pkgRoot, 'lib', 'bin.js'),
    [
      '#!/usr/bin/env node',
      'const fs = require("fs")',
      'const file = "cordis.patch.yml"',
      'let text = ""',
      'try { text = fs.readFileSync(file, "utf8") } catch { process.exit(2) }',
      'if (text.includes("BAD")) { console.error("YAMLException: bad indentation of a mapping entry (1:2)"); process.exit(1) }',
      'console.log("[]")',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: broken\n      name: BAD\n')
  const older = path.join(dir, 'cordis.patch.yml.bak-20260101-000000')
  fs.writeFileSync(older, '[]\n')
  const spec = { nodePath: process.execPath, binPath, argvExact: [process.execPath, binPath] }
  assert.equal(patchBackups(dir).length, 1)
  const result = rollbackProfilePatch({ profileDir: dir, profile, spec })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.applied, 'cordis.patch.yml.bak-20260101-000000')
  assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), '[]\n')
  const broken = fs.readdirSync(dir).filter((name) => name.startsWith('cordis.patch.yml.guard-broken-'))
  assert.equal(broken.length, 1)
  assert.match(fs.readFileSync(path.join(dir, broken[0]), 'utf8'), /BAD/)
})

test('the rollback refuses when there is no backup to fall back to', async () => {
  const home = tmpHome()
  const dir = profileDir(home, 'web')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n')
  const result = rollbackProfilePatch({ profileDir: dir, profile: 'web', spec: { nodePath: process.execPath } })
  assert.equal(result.ok, false)
  assert.match(result.error, /no cordis\.patch\.yml backups/)
})
