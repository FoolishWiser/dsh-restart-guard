// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseCredentialRefs, readDshCredentials, resolveModelKey } from '../lib/shared/credentials.js'

test('parses the refs block and stops at the next top-level key', () => {
  const yaml = [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-aaa',
    '  "QUOTED_KEY": "sk-quoted"',
    "  XIAOMI_API_KEY: 'sk-single'",
    'records:',
    '  client-connection/browser-session:',
    '    kind: secret',
    '    token: should-not-appear',
  ].join('\n')
  const refs = parseCredentialRefs(yaml)
  assert.deepEqual(Object.keys(refs).sort(), ['DEEPSEEK_API_KEY', 'QUOTED_KEY', 'XIAOMI_API_KEY'])
  assert.equal(refs.QUOTED_KEY, 'sk-quoted')
  assert.equal(refs.XIAOMI_API_KEY, 'sk-single')
  assert.equal(refs.token, undefined)
})

test('reads the harness credential file from DSH_HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-cred-'))
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-file\n')
  const got = readDshCredentials({ DSH_HOME: home })
  assert.equal(got.exists, true)
  assert.equal(got.refs.DEEPSEEK_API_KEY, 'sk-file')
  assert.equal(readDshCredentials({ DSH_HOME: path.join(home, 'missing') }).exists, false)
})

test('resolves env first, then the dsh store, and reports the source', () => {
  const store = () => ({ refs: { DEEPSEEK_API_KEY: 'sk-store' }, path: '/x/.credentials.yaml', exists: true, error: '' })
  const fromEnv = resolveModelKey({ keyEnv: 'DEEPSEEK_API_KEY', env: { DEEPSEEK_API_KEY: 'sk-env' }, read: store })
  assert.equal(fromEnv.apiKey, 'sk-env')
  assert.equal(fromEnv.keySource, 'env')

  const fromStore = resolveModelKey({ keyEnv: 'DEEPSEEK_API_KEY', env: {}, read: store })
  assert.equal(fromStore.apiKey, 'sk-store')
  assert.equal(fromStore.keySource, 'dsh-store')
  assert.equal(fromStore.keyName, 'DEEPSEEK_API_KEY')

  const dshOnly = resolveModelKey({ keyEnv: 'DEEPSEEK_API_KEY', source: 'dsh', env: { DEEPSEEK_API_KEY: 'sk-env' }, read: store })
  assert.equal(dshOnly.apiKey, 'sk-store')

  const missing = resolveModelKey({ keyEnv: 'DEEPSEEK_API_KEY', env: {}, read: () => ({ refs: {}, path: '/x', exists: false, error: 'not found' }) })
  assert.equal(missing.apiKey, '')
  assert.equal(missing.keySource, 'missing')
})
