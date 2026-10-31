// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { install, uninstall } from '../lib/install.mjs'
import { profileDir, tmpHome } from './helpers.mjs'

/** @param {string} home @returns {Record<string,string>} */
function envFor(home) {
  const stub = path.join(home, 'pnpm-stub')
  fs.writeFileSync(stub, '#!/bin/sh\nmkdir -p node_modules/dsh-restart-guard\nexit 0\n', { mode: 0o755 })
  return { DSH_HOME: home, DSH_RESTART_GUARD_PNPM: stub }
}

/** @param {string} profile @returns {any} */
function readPackage(profile) {
  return JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
}

test('install links the plugin and appends it to the bundle order, with a backup', () => {
  const home = tmpHome()
  const profile = 'web'
  const dir = profileDir(home, profile)
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'profile-web', dependencies: { existing: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
  )
  const result = install({ env: envFor(home), profile, root: '/repo/dsh-restart-guard' })
  assert.equal(result.ok, true, result.hints.join('\n'))
  const pkg = readPackage(dir)
  assert.equal(pkg.dependencies['dsh-restart-guard'], 'link:/repo/dsh-restart-guard')
  assert.equal(pkg.dependencies.existing, '1.0.0')
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-restart-guard'])
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'dsh-restart-guard')))
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith('package.json.guard-bak-'))
  assert.equal(backups.length, 1)
  assert.match(result.hints.join('\n'), /Settings/)
})

test('install is idempotent', () => {
  const home = tmpHome()
  const profile = 'web'
  const dir = profileDir(home, profile)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['base'] } } }))
  const env = envFor(home)
  install({ env, profile, root: '/repo/a' })
  const second = install({ env, profile, root: '/repo/a' })
  assert.equal(second.ok, true)
  const bundles = readPackage(dir).dsh.profile.bundles
  assert.deepEqual(bundles, ['base', 'dsh-restart-guard'])
})

test('a dry run changes nothing', () => {
  const home = tmpHome()
  const profile = 'web'
  const dir = profileDir(home, profile)
  const before = JSON.stringify({ dsh: { profile: { bundles: [] } } })
  fs.writeFileSync(path.join(dir, 'package.json'), before)
  const result = install({ env: envFor(home), profile, root: '/repo/x', dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before)
  assert.match(result.hints.join('\n'), /dry run/)
})

test('install refuses an unknown profile', () => {
  const home = tmpHome()
  assert.throws(() => install({ env: envFor(home), profile: 'missing', root: '/x' }), /not found/)
})

test('uninstall removes the dependency and the bundle entry but keeps state', () => {
  const home = tmpHome()
  const profile = 'web'
  const dir = profileDir(home, profile)
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      dependencies: { 'dsh-restart-guard': 'link:/x', keep: '1' },
      dsh: { profile: { bundles: ['base', 'dsh-restart-guard'] } },
    }),
  )
  const stateDir = path.join(home, 'restart-guard', 'instances', 'web-3079')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'state.json'), '{}')
  const result = uninstall({ env: envFor(home), profile })
  assert.equal(result.ok, true)
  const pkg = readPackage(dir)
  assert.equal('dsh-restart-guard' in pkg.dependencies, false)
  assert.equal(pkg.dependencies.keep, '1')
  assert.deepEqual(pkg.dsh.profile.bundles, ['base'])
  assert.ok(fs.existsSync(path.join(stateDir, 'state.json')))
  assert.match(result.hints.join('\n'), /purge/)
})
