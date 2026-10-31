// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildEnvironment, renderEnvironment } from '../lib/shared/environment.js'
import { tmpHome } from './helpers.mjs'

test('environment briefing collects the facts an operator would look at', async () => {
  const home = tmpHome()
  const profileDir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml.bak-1'), '[]\n')
  const logPath = path.join(home, 'boot.log')
  fs.writeFileSync(logPath, 'x'.repeat(128))
  const dir = path.join(home, 'guard')
  fs.mkdirSync(dir, { recursive: true })

  const facts = await buildEnvironment({
    env: { DSH_HOME: home },
    port: 31999,
    profile: 'web',
    instanceDir: dir,
    guardVersion: '0.1.3',
    state: { host: { pid: process.pid, startedAt: Date.now(), version: '0.2.1-rc.5' }, boot: { logPath }, health: { ok: false, kind: 'down' } },
    diagnosis: { incident: 'yaml-config', detail: 'bad indentation', evidence: ['YAMLException'] },
    supervisor: { kind: 'none', detail: 'parent' },
    maintenance: { active: false },
  })

  assert.equal(facts.port, 31999)
  assert.equal(facts.profile, 'web')
  assert.equal(facts.patchExists, true)
  assert.deepEqual(facts.patchBackups, ['cordis.patch.yml.bak-1'])
  assert.equal(facts.bootLogSize, 128)
  assert.equal(facts.incident, 'yaml-config')
  assert.equal(facts.supervisor, 'none')
  assert.ok(facts.envKeys.includes('DSH_HOME'), 'env is reduced to key names')

  const text = renderEnvironment(facts)
  assert.match(text, /port 31999/)
  assert.match(text, /host: .*node v/)
  assert.match(text, /cordis\.patch\.yml/)
  assert.match(text, /diagnosis: yaml-config/)
  assert.ok(!text.includes('sk-'), 'no secret material leaks into the briefing')
})
