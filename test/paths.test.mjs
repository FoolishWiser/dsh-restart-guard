// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  appendLine,
  clamp,
  dshHome,
  ensureDir,
  expandHome,
  guardRoot,
  instanceDir,
  instanceId,
  isInside,
  openAppendNoFollow,
  readJson,
  sanitizeId,
  writeJsonAtomic,
} from '../lib/shared/paths.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-path-'))

test('dshHome defaults to ~/.dsh and honours DSH_HOME', () => {
  assert.equal(dshHome({}), path.join(os.homedir(), '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '/srv/dsh' }), '/srv/dsh')
  assert.equal(dshHome({ DSH_HOME: '~/custom' }), path.join(os.homedir(), 'custom'))
})

test('expandHome replaces ~ and $DSH_HOME without recursing', () => {
  assert.equal(expandHome('~/x', {}), path.join(os.homedir(), 'x'))
  assert.equal(expandHome('$DSH_HOME/upgrade', { DSH_HOME: '/d' }), '/d/upgrade')
  assert.equal(expandHome('/plain', {}), '/plain')
})

test('instance ids and dirs are sanitised under the guard root', () => {
  assert.equal(sanitizeId('../web/../x'), '.._web_.._x')
  assert.equal(sanitizeId('web!'), 'web')
  assert.equal(sanitizeId(''), 'default')
  assert.equal(instanceId('web', 3079), 'web-3079')
  const dir = instanceDir({ DSH_HOME: '/d' }, 'web', 3079)
  assert.equal(dir, path.join('/d', 'restart-guard', 'instances', 'web-3079'))
  assert.equal(guardRoot({ DSH_HOME: '/d' }), path.join('/d', 'restart-guard'))
})

test('writeJsonAtomic writes readable JSON with 0600 and replaces content', () => {
  const dir = tmp()
  const file = path.join(dir, 'state.json')
  writeJsonAtomic(file, { a: 1 })
  assert.deepEqual(readJson(file, null), { a: 1 })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  writeJsonAtomic(file, { a: 2 })
  assert.deepEqual(readJson(file, null), { a: 2 })
})

test('openAppendNoFollow refuses a symlink', () => {
  const dir = tmp()
  const target = path.join(dir, 'target.log')
  const link = path.join(dir, 'link.log')
  fs.writeFileSync(target, 'x')
  fs.symlinkSync(target, link)
  assert.throws(() => openAppendNoFollow(link), /refusing to write through a symlink/)
  appendLine(target, 'ok')
  assert.equal(fs.readFileSync(target, 'utf8'), 'xok\n')
})

test('isInside rejects traversal', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-inside-'))
  const root = path.join(base, 'b')
  fs.mkdirSync(root)
  fs.mkdirSync(path.join(root, 'c'))
  assert.equal(isInside(root, path.join(root, 'c')), true)
  assert.equal(isInside(root, path.join(root, '..', 'base')), false)
  assert.equal(isInside(root, path.join(base, 'bc')), false)
})

test('small helpers behave', () => {
  assert.equal(clamp(5, 1, 3), 3)
  assert.equal(clamp(-5, 1, 3), 1)
  const dir = tmp()
  ensureDir(dir, 0o700)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
})
