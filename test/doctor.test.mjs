// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { DEFAULTS } from '../lib/shared/config.js'
import { buildDoctor } from '../lib/doctor.js'
import { fakeTree, profileDir, tmpHome } from './helpers.mjs'

/** @param {string} home */
function envFor(home) {
  const tree = fakeTree(home)
  return {
    env: { DSH_HOME: home, PATH: `${path.dirname(tree.binPath)}${path.delimiter}/usr/bin:/bin` },
    tree,
  }
}

test('a bare install reports the gaps the operator must fill', () => {
  const home = tmpHome()
  const { env } = envFor(home)
  const profile = 'web'
  const dir = profileDir(home, profile)
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  const doctor = buildDoctor({
    env,
    port: 3079,
    profile,
    instanceDir: path.join(home, 'inst'),
    config: DEFAULTS,
    watcher: { alive: false, pid: 0, heartbeatAt: 0, version: '' },
    imAvailable: false,
    probe: null,
  })
  const byId = Object.fromEntries(doctor.checks.map((check) => [check.id, check]))
  assert.equal(byId['dsh-bin'].ok, true)
  assert.equal(byId.tree.ok, true)
  assert.equal(byId.watcher.ok, false)
  assert.equal(byId.watcher.level, 'error')
  assert.equal(byId.webhook.ok, false)
  assert.equal(byId.im.ok, false)
  assert.equal(byId['boot-log'].ok, false)
  const hints = doctor.hints.map((hint) => hint.id)
  assert.ok(hints.includes('webhook-missing'), hints.join(','))
  assert.ok(hints.includes('im-missing'))
  assert.ok(hints.includes('boot-log-unknown') || hints.includes('no-launch-spec'))
  assert.ok(hints.includes('dangerous-actions-off'))
  assert.equal(doctor.summary.ok, false, 'a missing watcher is an error, not a warning')
  assert.equal(doctor.summary.ready, false)
})

test('a configured install is ready', () => {
  const home = tmpHome()
  const { env } = envFor(home)
  const profile = 'web'
  const dir = profileDir(home, profile)
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: a\n      name: a\n')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml.bak-1'), '[]\n')
  const instanceDir = path.join(home, 'inst')
  fs.mkdirSync(instanceDir, { recursive: true })
  fs.writeFileSync(path.join(instanceDir, 'launch.json'), JSON.stringify({ stdoutPath: path.join(home, 'boot.log') }))
  const config = {
    ...DEFAULTS,
    notify: {
      ...DEFAULTS.notify,
      webhook: { ...DEFAULTS.notify.webhook, enabled: true, url: 'https://hooks.test/x' },
      im: { ...DEFAULTS.notify.im, enabled: true, botId: 'bot', targetId: 'target' },
    },
    security: { ...DEFAULTS.security, dangerousActions: true },
  }
  const doctor = buildDoctor({
    env,
    port: 3079,
    profile,
    instanceDir,
    config,
    watcher: { alive: true, pid: 42, heartbeatAt: Date.now(), version: '0.1.0' },
    imAvailable: true,
    probe: { ok: true, kind: 'dsh', status: 401 },
  })
  const byId = Object.fromEntries(doctor.checks.map((check) => [check.id, check]))
  assert.equal(byId.tree.ok, true)
  assert.equal(byId.port.ok, true)
  assert.equal(byId.watcher.ok, true)
  assert.equal(byId.webhook.ok, true)
  assert.equal(byId.im.ok, true)
  assert.equal(byId['boot-log'].ok, true)
  assert.equal(byId.maintenance.ok, true)
  assert.equal(doctor.summary.ok, true)
  assert.equal(doctor.summary.ready, true)
  assert.deepEqual(doctor.hints, [])
})

test('a broken patch is an error with a hint, backups are counted', () => {
  const home = tmpHome()
  const { env } = envFor(home)
  const profile = 'web'
  const dir = profileDir(home, profile)
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), 'this: is: not: a: list\n  bad: [\n')
  const doctor = buildDoctor({
    env,
    port: 3079,
    profile,
    instanceDir: path.join(home, 'inst'),
    config: { ...DEFAULTS, security: { ...DEFAULTS.security, dangerousActions: true } },
    watcher: { alive: true, pid: 42, heartbeatAt: Date.now(), version: '0.1.0' },
    imAvailable: false,
    probe: { ok: false, kind: 'down', status: 0 },
  })
  const byId = Object.fromEntries(doctor.checks.map((check) => [check.id, check]))
  assert.equal(byId['patch-yaml'].ok, false)
  assert.equal(byId['patch-yaml'].level, 'error')
  assert.equal(byId['patch-backups'].ok, false)
  assert.ok(doctor.hints.some((hint) => hint.id === 'patch-yaml-suspicious'))
  assert.ok(doctor.hints.some((hint) => hint.id === 'patch-no-backup'))
  assert.equal(doctor.summary.ok, false)
})

test('an explicit maintenance window is surfaced, not hidden', () => {
  const home = tmpHome()
  const { env } = envFor(home)
  const profile = 'web'
  profileDir(home, profile)
  const instanceDir = path.join(home, 'inst')
  fs.mkdirSync(path.join(instanceDir, 'control'), { recursive: true })
  fs.writeFileSync(
    path.join(instanceDir, 'control', 'maintenance.json'),
    JSON.stringify({ until: Date.now() + 60000, reason: 'upgrade' }),
  )
  const doctor = buildDoctor({
    env,
    port: 3079,
    profile,
    instanceDir,
    config: DEFAULTS,
    watcher: { alive: true, pid: 42, heartbeatAt: Date.now(), version: '0.1.0' },
    imAvailable: false,
    probe: { ok: false, kind: 'down', status: 0 },
  })
  const byId = Object.fromEntries(doctor.checks.map((check) => [check.id, check]))
  assert.equal(byId.maintenance.ok, false)
  assert.equal(doctor.summary.maintenance, 'explicit')
  assert.ok(doctor.hints.some((hint) => hint.id === 'maintenance-active'))
})

test('a comment-prefixed patch list is not reported as broken', () => {
  const home = tmpHome()
  const { env } = envFor(home)
  const profile = 'web'
  const dir = profileDir(home, profile)
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  const patchPath = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(
    patchPath,
    '# a top-level YAML array of loader patch entries\n# comments are fine above the list\n- id: demo\n  name: demo\n',
  )
  /** @param {number} port */
  const report = (port) =>
    buildDoctor({
      env,
      port,
      profile,
      instanceDir: path.join(home, 'inst'),
      config: DEFAULTS,
      watcher: { alive: false, pid: 0, heartbeatAt: 0, version: '' },
      imAvailable: false,
      probe: null,
    })
  const good = report(1).checks.find((item) => item.id === 'patch-yaml')
  assert.equal(good.ok, true)
  assert.match(good.detail, /YAML array/)

  fs.writeFileSync(patchPath, '- id: demo\n\tname: tabbed\n')
  assert.equal(report(1).checks.find((item) => item.id === 'patch-yaml').ok, false)
})
