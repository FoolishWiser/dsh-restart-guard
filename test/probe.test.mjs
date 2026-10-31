// @ts-check
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  classifyProbe,
  findPidsByPort,
  httpProbe,
  pidAlive,
  pidCmdline,
  portOpen,
  waitPortClosed,
} from '../lib/shared/probe.js'

/** @param {number} status @param {string} body @param {string} [contentType] */
function server(status, body, contentType = 'text/plain') {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(status, { 'content-type': contentType })
      res.end(body)
    })
    srv.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (srv.address())
      resolve({ srv, port: address.port })
    })
  })
}

test('classifyProbe recognises DSH behind the authentication wall', () => {
  const dsh = classifyProbe(401, 'dsh web authentication required; reopen the URL printed by dsh web.')
  assert.equal(dsh.ok, true)
  assert.equal(dsh.kind, 'dsh')
  assert.equal(classifyProbe(200, '<html>__DSH_BOOT__</html>').kind, 'dsh')
  assert.equal(classifyProbe(200, '<html>nginx</html>').kind, 'foreign')
  assert.equal(classifyProbe(302, '').kind, 'foreign')
  assert.equal(classifyProbe(500, 'boom').kind, 'unexpected')
  assert.equal(classifyProbe(0, '').kind, 'unexpected')
  assert.equal(classifyProbe(401, 'please log in').kind, 'unexpected')
})

test('httpProbe reads status and a bounded body', async () => {
  const { srv, port } = await server(401, 'dsh web authentication required')
  try {
    const result = await httpProbe({ port, timeoutMs: 2000 })
    assert.equal(result.status, 401)
    assert.equal(result.kind, 'dsh')
    assert.match(result.snippet, /authentication required/)
  } finally {
    srv.close()
  }
})

test('httpProbe reports a closed port as down', async () => {
  const result = await httpProbe({ port: 1, timeoutMs: 500 })
  assert.equal(result.kind, 'down')
  assert.equal(result.status, 0)
  assert.match(result.error, /ECONNREFUSED/)
})

test('portOpen and waitPortClosed track a listener', async () => {
  const { srv, port } = await server(200, 'ok')
  try {
    assert.equal(await portOpen(port), true)
  } finally {
    srv.close()
  }
  assert.equal(await waitPortClosed(port, 3000), true)
  assert.equal(await portOpen(port), false)
})

test('pidAlive and pidCmdline describe the current process', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(2 ** 22 + 7), false)
  assert.match(pidCmdline(process.pid).join(' '), /node/)
})

test('findPidsByPort finds this process for its listening socket', async () => {
  const { srv, port } = await server(200, 'ok')
  try {
    const found = findPidsByPort(port)
    assert.ok(found.pids.includes(process.pid), `expected pid ${process.pid} in ${JSON.stringify(found)}`)
  } finally {
    srv.close()
  }
})
