// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  bootAudit,
  failureFingerprint,
  parseAccessLine,
  parseBootFailure,
  parseLoaderDetails,
  readLogSegment,
  tailSegment,
} from '../lib/shared/diagnose.js'

test('classifies a YAML failure before the generic crash path', () => {
  const diagnosis = parseBootFailure(
    'YAMLException: bad indentation of a mapping entry (3:5)\n  at load (file:///profile/cordis.patch.yml)',
  )
  assert.equal(diagnosis.incident, 'yaml-config')
  assert.ok(diagnosis.evidence.some((line) => line.includes('YAMLException')))
})

test('classifies wildcard host, port in use, module and permission failures', () => {
  const cases = [
    ['dsh: host "0.0.0.0" is an unspecified (wildcard) address', 'wildcard-host'],
    ['Error: listen EADDRINUSE: address already in use 127.0.0.1:3079', 'port-in-use'],
    ['Error [ERR_MODULE_NOT_FOUND]: Cannot find package "x"', 'module-missing'],
    ['Error: EACCES: permission denied, open /root/.dsh/config.json', 'permission-disk-memory'],
    ['Segmentation fault (core dumped)', 'crash'],
    ['dsh: startup failed: 3 entries did not activate', 'startup-failed'],
    ['plugin(s) failed to load: a, b', 'plugin-failed'],
    ['cannot get property "webRuntime" without inject', 'patch-incompatible'],
    ['something odd happened', 'unknown'],
  ]
  for (const [text, incident] of cases) {
    assert.equal(parseBootFailure(text).incident, incident, text)
  }
})

test('loader details pick the last marker block', () => {
  const activation = [
    '4 entries did not activate',
    'row-one (@scope/one): waiting for service',
    'row-two (@scope/two): pending (waiting for dependency)',
    '  at ignored (file:///x.js:1:1)',
  ].join('\n')
  assert.deepEqual(parseLoaderDetails(activation).inactive, [
    'row-one (@scope/one): waiting for service',
    'row-two (@scope/two): pending (waiting for dependency)',
  ])
  // The last marker wins: a later "plugin(s) failed to load" line hides the
  // earlier activation block, because that is the failure the boot ended on.
  const mixed = `${activation}\nplugin(s) failed to load: @scope/a, @scope/b`
  const details = parseLoaderDetails(mixed)
  assert.deepEqual(details.unresolved, ['@scope/a', '@scope/b'])
  assert.deepEqual(details.inactive, [])
})

test('loader details expose the failing entry id and name', () => {
  const details = parseLoaderDetails('failed to apply loader entry row-x (@scope/x): boom')
  assert.equal(details.entryId, 'row-x')
  assert.equal(details.entryName, '@scope/x')
})

test('parseAccessLine finds the last access line and its token', () => {
  const text = [
    'noise',
    'dsh web: http://127.0.0.1:3079/?token=old',
    'more noise',
    'dsh web: http://127.0.0.1:3079/?token=fresh123456',
  ].join('\n')
  const found = parseAccessLine(text)
  assert.equal(found.found, true)
  assert.equal(found.hasToken, true)
  assert.match(found.line, /token=fresh123456/)
  assert.equal(parseAccessLine('nothing here').found, false)
  assert.equal(parseAccessLine('dsh web: http://x/').hasToken, false)
})

test('bootAudit reports fatal patterns and missing access lines', () => {
  const audit = bootAudit('dsh web: http://x/?token=t\nfailed to mount foo\nCannot find module "y"', [
    'failed to mount',
    'Cannot find module',
  ])
  assert.equal(audit.fatal, true)
  assert.equal(audit.hits.length, 2)
  const clean = bootAudit('dsh web: http://x/?token=t', ['failed to mount'])
  assert.equal(clean.fatal, false)
  assert.equal(clean.hits.length, 0)
  assert.equal(parseAccessLine('dsh web: http://x/?token=t').found, true)
})

test('failureFingerprint is stable for the same failure', () => {
  const a = failureFingerprint(parseBootFailure('YAMLException: bad indentation (3:5)'))
  const b = failureFingerprint(parseBootFailure('YAMLException: bad indentation (3:5)'))
  const c = failureFingerprint(parseBootFailure('listen EADDRINUSE'))
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('log segments respect the byte offset and never read old tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-log-'))
  const file = path.join(dir, 'boot.log')
  fs.writeFileSync(file, 'dsh web: http://x/?token=old\n')
  const offset = fs.statSync(file).size
  fs.appendFileSync(file, 'dsh web: http://x/?token=new\n')
  const segment = readLogSegment(file, offset, 1024)
  assert.match(segment.text, /token=new/)
  assert.doesNotMatch(segment.text, /token=old/)
  const tail = tailSegment(file, 1024)
  assert.match(tail.text, /token=new/)
  assert.equal(tail.offset, 0)
})

test('readLogSegment handles a missing file', () => {
  const segment = readLogSegment('/nonexistent/boot.log', 0, 100)
  assert.equal(segment.text, '')
  assert.equal(segment.size, 0)
})

test('parseBootFailure reads the real "Failed plugins" startup block', () => {
  const text = [
    'dsh: startup failed: 1 required plugin did not activate',
    '',
    'Failed plugins (2):',
    '  modules (required)',
    '    Package: dsh-demo-broken',
    '    Error: dsh-demo-broken: demo-config.json has enabled=false; set enabled to true',
    '        at new apply (file:///demo/broken-plugin/index.js:26:11)',
    '  web-ui-task-board',
    '    Package: @linxin666/dsh-client-ui-task-board',
    '    Error: task-board ledger is already owned by process 4441',
    '',
    'Plugins waiting for services (1):',
    '  Plugin      Missing services',
    '  client-hmr  clientModules',
  ].join('\n')
  const result = parseBootFailure(text)
  assert.equal(result.incident, 'startup-failed')
  assert.equal(result.entryId, 'modules')
  assert.equal(result.entryName, 'dsh-demo-broken')
  assert.equal(result.required, true)
  assert.equal(result.failedPlugins.length, 2)
  assert.equal(result.failedPlugins[1].id, 'web-ui-task-board')
  assert.equal(result.failedPlugins[1].required, false)
  assert.match(result.failedPlugins[0].detail, /enabled=false/)
  assert.match(result.evidence.join(' '), /startup failed/)
})
