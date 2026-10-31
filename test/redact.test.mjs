// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  envKeyNames,
  isSensitiveKey,
  maskUrl,
  redactArgv,
  redactConfig,
  redactText,
  stripAnsi,
  tailForReport,
} from '../lib/shared/redact.js'

test('stripAnsi removes colour codes', () => {
  assert.equal(stripAnsi('\u001b[31merror\u001b[0m'), 'error')
})

test('redactText masks tokens in URLs, headers and assignments', () => {
  assert.equal(redactText('open http://127.0.0.1:3079/?token=abcdef123456'), 'open http://127.0.0.1:3079/?token=***')
  assert.equal(redactText('Authorization: Bearer abc.def'), 'Authorization: ***')
  assert.doesNotMatch(redactText('Authorization: Bearer abc.def'), /abc\.def/)
  assert.doesNotMatch(redactText('DSH_TOKEN=s3cretvalue'), /s3cretvalue/)
  assert.match(redactText('api_key: 1234567890'), /api_key: \*\*\*/)
  assert.doesNotMatch(redactText('{"cookie":"a=b"}'), /a=b/)
  assert.equal(redactText('https://hooks.example/x?access_token=abcdefgh'), 'https://hooks.example/x?access_token=***')
})

test('redactText masks caller-supplied secrets', () => {
  assert.equal(redactText('boot token abcdefghij', { secrets: ['abcdefghij'] }), 'boot token ***')
})

test('redactArgv masks a flag value and the following argument', () => {
  assert.deepEqual(redactArgv(['dsh', 'web', '--token=abc123', '--port', '3079']), [
    'dsh',
    'web',
    '--token=***',
    '--port',
    '3079',
  ])
  assert.deepEqual(redactArgv(['dsh', 'web', '--password', 'hunter2', '--port', '3079']), [
    'dsh',
    'web',
    '--password',
    '***',
    '--port',
    '3079',
  ])
})

test('isSensitiveKey covers the usual names', () => {
  for (const key of ['token', 'api_key', 'password', 'Cookie', 'authorization', 'signature']) {
    assert.equal(isSensitiveKey(key), true, key)
  }
  for (const key of ['port', 'profile', 'host']) assert.equal(isSensitiveKey(key), false, key)
})

test('maskUrl keeps only scheme and host', () => {
  assert.equal(maskUrl('https://hooks.example.test/a/b?key=1'), 'https://hooks.example.test/***')
  assert.equal(maskUrl('not a url'), '***')
  assert.equal(maskUrl(''), '')
})

test('redactConfig masks webhook and IM identifiers', () => {
  const config = {
    notify: {
      webhook: { url: 'https://hooks.test/x', secret: 'shh', headers: { Authorization: 'Basic x', 'X-Env': 'prod' } },
      im: { botId: 'bot-1234567890', targetId: 'alerts' },
    },
  }
  const out = redactConfig(config)
  assert.equal(out.notify.webhook.url, 'https://hooks.test/***')
  assert.equal(out.notify.webhook.secret, '***')
  assert.equal(out.notify.webhook.headers.Authorization, '***')
  assert.equal(out.notify.webhook.headers['X-Env'], 'prod')
  assert.equal(out.notify.im.botId, 'bo***90')
  assert.equal(out.notify.im.targetId, 'alerts')
})

test('envKeyNames returns names only', () => {
  assert.deepEqual(envKeyNames({ B: '2', A: '1' }), ['A', 'B'])
})

test('tailForReport keeps the last lines and caps the size', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${index} token=abcdef`).join('\n')
  const tail = tailForReport(text, 3, 500)
  assert.equal(tail.split('\n').length, 3)
  assert.match(tail, /line 9 token=\*\*\*/)
  assert.doesNotMatch(tail, /abcdef/)
})
