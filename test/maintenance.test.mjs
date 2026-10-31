// @ts-check
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULTS } from '../lib/shared/config.js'
import {
  detectMaintenance,
  detectRestarters,
  latestUpgradeDir,
  siblingTrees,
  treeSnapshot,
  upgradeTerminal,
} from '../lib/shared/maintenance.js'
import { fakeTree, profileDir, tmpHome } from './helpers.mjs'

/** @param {string} dir @param {string} name @param {string} text */
function write(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text)
}

test('sibling trees are the leftover of a cutover', () => {
  const home = tmpHome()
  const { pkgRoot } = fakeTree(home)
  fs.mkdirSync(`${pkgRoot}.prev-20260101`)
  fs.mkdirSync(`${pkgRoot}.new`)
  fs.mkdirSync(`${pkgRoot}.failed-2`)
  const siblings = siblingTrees(pkgRoot).map((dir) => path.basename(dir)).sort()
  assert.deepEqual(siblings, ['fake-dsh.failed-2', 'fake-dsh.new', 'fake-dsh.prev-20260101'])
})

test('treeSnapshot reads the version through the bin symlink', () => {
  const home = tmpHome()
  const { binPath, pkgRoot } = fakeTree(home)
  const snapshot = treeSnapshot(profileDir(home, 'web'), binPath)
  assert.equal(snapshot.pkgRoot, pkgRoot)
  assert.equal(snapshot.version, '0.0.0-test')
  assert.equal(snapshot.exists, true)
  assert.ok(snapshot.ino > 0)
})

test('upgradeTerminal reads result json, status.jsonl and SUMMARY.md', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-up-'))
  const ok = path.join(base, 'ok')
  fs.mkdirSync(ok)
  write(ok, 'result-r2.json', JSON.stringify({ ok: true }))
  assert.equal(upgradeTerminal(ok), 'done')
  const failed = path.join(base, 'failed')
  fs.mkdirSync(failed)
  write(failed, 'status.jsonl', '{"phase":"swap"}\n{"phase":"result","ok":false}\n')
  assert.equal(upgradeTerminal(failed), 'failed')
  const running = path.join(base, 'running')
  fs.mkdirSync(running)
  write(running, 'status.jsonl', '{"phase":"preflight"}\n{"phase":"swap"}\n')
  assert.equal(upgradeTerminal(running), 'running')
  assert.equal(upgradeTerminal(path.join(base, 'missing')), 'unknown')
})

test('latestUpgradeDir picks the newest directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-latest-'))
  fs.mkdirSync(path.join(root, 'old'))
  fs.mkdirSync(path.join(root, 'new'))
  const later = Date.now() + 10_000
  fs.utimesSync(path.join(root, 'new'), new Date(later), new Date(later))
  assert.equal(path.basename(latestUpgradeDir(root)), 'new')
  assert.equal(latestUpgradeDir(path.join(root, 'nope')), '')
})

test('detectMaintenance honours an explicit window and the grace period', () => {
  const home = tmpHome()
  const { binPath } = fakeTree(home)
  const now = Date.now()
  const instance = { dir: path.join(home, 'inst'), hostPid: 1, pkgRoot: '', profileDir: profileDir(home, 'web'), binPath, baseline: null }
  const explicit = detectMaintenance({
    now,
    config: DEFAULTS,
    env: { DSH_HOME: home },
    instance,
    explicit: { until: now + 60_000, reason: 'upgrade' },
  })
  assert.equal(explicit.active, true)
  assert.equal(explicit.signal, 'explicit')
  assert.ok((explicit.until ?? 0) >= now + DEFAULTS.maintenance.graceMs)
  assert.equal(explicit.treeIntact, true)

  const expired = detectMaintenance({ now, config: DEFAULTS, env: { DSH_HOME: home }, instance, explicit: { until: now - 1 } })
  assert.equal(expired.signal, 'none')
})

test('a sibling tree puts the guard in maintenance without an explicit window', () => {
  const home = tmpHome()
  const { binPath, pkgRoot } = fakeTree(home)
  fs.mkdirSync(`${pkgRoot}.prev-1`)
  const status = detectMaintenance({
    now: Date.now(),
    config: DEFAULTS,
    env: { DSH_HOME: home },
    instance: { dir: path.join(home, 'i'), hostPid: 1, pkgRoot, profileDir: profileDir(home, 'web'), binPath, baseline: null },
    explicit: null,
  })
  assert.equal(status.active, true)
  assert.equal(status.signal, 'sibling-tree')
  assert.ok(status.signals.some((line) => line.includes('sibling-trees')))
})

test('a leftover tree from a finished upgrade does not hold the guard forever', () => {
  const home = tmpHome()
  const { binPath, pkgRoot } = fakeTree(home)
  const stale = `${pkgRoot}.prev-20260101`
  fs.mkdirSync(stale)
  fs.utimesSync(stale, new Date(0), new Date(0))
  const status = detectMaintenance({
    now: Date.now(),
    config: DEFAULTS,
    env: { DSH_HOME: home },
    instance: { dir: path.join(home, 'i'), hostPid: 1, pkgRoot, profileDir: profileDir(home, 'web'), binPath, baseline: null },
    explicit: null,
  })
  assert.equal(status.active, false, status.signals.join(', '))
  assert.equal(status.signal, 'none')
})

test('a recent upgrade directory is a maintenance signal, terminal states included', () => {
  const home = tmpHome()
  const { binPath } = fakeTree(home)
  const upgrade = path.join(home, 'upgrade', '20260101-000000')
  fs.mkdirSync(upgrade, { recursive: true })
  write(upgrade, 'result-r1.json', JSON.stringify({ ok: false }))
  const status = detectMaintenance({
    now: Date.now(),
    config: DEFAULTS,
    env: { DSH_HOME: home },
    instance: { dir: path.join(home, 'i'), hostPid: 1, pkgRoot: '', profileDir: profileDir(home, 'web'), binPath, baseline: null },
    explicit: null,
  })
  assert.equal(status.active, true)
  assert.equal(status.signal, 'upgrade-dir')
  assert.equal(status.terminal, 'failed')
  assert.match(status.upgradeDir, /20260101-000000/)
})

test('detectRestarters finds a process whose command line matches', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'restart-dsh-web'], { stdio: 'ignore' })
  try {
    const found = detectRestarters({ patterns: ['restart[-_.]?dsh'], excludePid: process.pid, maxAgeMs: 120000 })
    assert.ok(found.some((proc) => proc.pid === child.pid), JSON.stringify(found))
    const excluded = detectRestarters({ patterns: ['restart[-_.]?dsh'], excludePid: child.pid, maxAgeMs: 120000 })
    assert.equal(excluded.some((proc) => proc.pid === child.pid), false)
  } finally {
    child.kill('SIGTERM')
  }
})
