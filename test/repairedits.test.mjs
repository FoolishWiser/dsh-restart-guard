// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applyAiEdits,
  buildPluginMaterial,
  disablePatchEntry,
  resolveFailingPackage,
  restoreAiEdits,
  restorePatchEntry,
} from '../lib/repair.js'

/** @param {string} prefix */
function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A fake dsh binary: `--dump-config` succeeds unless the patch text is broken. */
function fakeBin(dir) {
  const bin = path.join(dir, 'dsh')
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
import fs from 'node:fs'
const patch = ${JSON.stringify(path.join(dir, 'cordis.patch.yml'))}
if (process.argv.includes('--dump-config')) {
  const text = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : ''
  if (/^BAD/m.test(text)) {
    process.stderr.write('bad patch\\n')
    process.exit(1)
  }
  process.stdout.write('[]\\n')
}
`,
    { mode: 0o755 },
  )
  return bin
}

test('resolveFailingPackage: finds a linked plugin and refuses protected names', () => {
  const home = tmp('guard-home-')
  const profileDir = path.join(home, 'profiles', 'web')
  const pkg = path.join(home, 'plugins', 'demo-broken')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(pkg, { recursive: true })
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"demo-broken"}\n')
  fs.symlinkSync(pkg, path.join(profileDir, 'node_modules', 'demo-broken'), 'dir')
  const ok = resolveFailingPackage({ profileDir, entryName: 'demo-broken' })
  assert.equal(ok.ok, true)
  assert.equal(/** @type {any} */ (ok).dir, fs.realpathSync(pkg))
  const missing = resolveFailingPackage({ profileDir, entryName: 'nope' })
  assert.equal(missing.ok, false)
  const core = resolveFailingPackage({ profileDir, entryName: '@deepseek-ai/dsh-base' })
  assert.equal(core.ok, false)
  assert.match(/** @type {any} */ (core).error, /core package/)
})

test('applyAiEdits: writes with a backup, then restoreAiEdits puts it back', () => {
  const dir = tmp('guard-pkg-')
  const file = path.join(dir, 'index.js')
  const original = 'export const name = "x"\n'
  fs.writeFileSync(file, original)
  const result = applyAiEdits({
    packageDir: dir,
    edits: [{ file: 'index.js', content: 'export const name = "y"\n' }],
  })
  assert.equal(result.ok, true)
  const changed = /** @type {any} */ (result).changed
  assert.equal(changed.length, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const name = "y"\n')
  assert.equal(fs.readFileSync(changed[0].backup, 'utf8'), original)
  const restored = restoreAiEdits({ changed })
  assert.equal(restored.ok, true)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})

test('applyAiEdits: a syntax error rolls every file back', () => {
  const dir = tmp('guard-pkg-')
  const good = path.join(dir, 'a.js')
  const bad = path.join(dir, 'b.js')
  fs.writeFileSync(good, 'export const a = 1\n')
  fs.writeFileSync(bad, 'export const b = 1\n')
  const result = applyAiEdits({
    packageDir: dir,
    edits: [
      { file: 'a.js', content: 'export const a = 2\n' },
      { file: 'b.js', content: 'export const b = = 2\n' },
    ],
  })
  assert.equal(result.ok, false)
  assert.match(/** @type {any} */ (result).error, /b\.js/)
  assert.equal(fs.readFileSync(good, 'utf8'), 'export const a = 1\n')
  assert.equal(fs.readFileSync(bad, 'utf8'), 'export const b = 1\n')
})

test('applyAiEdits: refuses paths outside the package and missing files', () => {
  const dir = tmp('guard-pkg-')
  fs.writeFileSync(path.join(dir, 'index.js'), 'export {}\n')
  const escape = applyAiEdits({ packageDir: dir, edits: [{ file: '../evil.js', content: 'x' }] })
  assert.equal(escape.ok, false)
  const absolute = applyAiEdits({ packageDir: dir, edits: [{ file: '/etc/passwd', content: 'x' }] })
  assert.equal(absolute.ok, false)
  const missing = applyAiEdits({ packageDir: dir, edits: [{ file: 'demo-config.json', content: '{}' }] })
  assert.equal(missing.ok, false)
  assert.match(/** @type {any} */ (missing).error, /does not exist/)
})

test('buildPluginMaterial: includes package.json, entry file and config', () => {
  const dir = tmp('guard-pkg-')
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo-broken","main":"index.js"}\n')
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n')
  fs.writeFileSync(path.join(dir, 'demo-config.json'), '{"enabled":false}\n')
  const text = buildPluginMaterial({ packageDir: dir, entryId: 'modules', entryName: 'demo-broken', required: true })
  assert.match(text, /- entry: modules \(required\)/)
  assert.match(text, /- package: demo-broken/)
  assert.match(text, /- directory: /)
  assert.match(text, /demo-config\.json/)
  assert.match(text, /"enabled":false/)
})

test('disablePatchEntry then restorePatchEntry round-trips the profile patch', () => {
  const home = tmp('guard-home-')
  const profileDir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profileDir, { recursive: true })
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  const original = '# top-level YAML array of loader patch entries\n- id: some-plugin\n  settings: {}\n'
  fs.writeFileSync(patchPath, original)
  const spec = { binPath: fakeBin(home), cwd: profileDir, argv: [fakeBin(home), 'web'], nodePath: process.execPath }
  const result = disablePatchEntry({ profileDir, profile: 'web', spec, entryId: 'demo-broken', entryName: 'dsh-demo-broken' })
  assert.equal(result.ok, true)
  const patched = fs.readFileSync(patchPath, 'utf8')
  assert.match(patched, /- id: demo-broken/)
  assert.match(patched, /disabled: true/)
  assert.match(patched, /- id: some-plugin/)
  const restored = restorePatchEntry({ patchPath, backup: /** @type {any} */ (result).backup })
  assert.equal(restored.ok, true)
  assert.equal(fs.readFileSync(patchPath, 'utf8'), original)
})
