// @ts-check
/**
 * A stand-in for `dsh web` used by the tests and the crash-drill docs.
 *
 * It behaves like the real server in the two ways the guard depends on:
 *   - it prints the access line (`dsh web: http://127.0.0.1:<port>/?token=…`)
 *     once it is listening;
 *   - the root route answers 401 with the DSH authentication text until a
 *     session cookie exists (the guard treats exactly that as healthy).
 *
 * Modes (env FAKE_DSH_MODE):
 *   ok            always boot
 *   fail          print a boot failure and exit 1 every time
 *   fail-once     fail the first run (counter in FAKE_DSH_COUNTER), then boot
 *   foreign       serve a generic 200 page (port taken by something else)
 *   silent        listen but never print the access line
 *   hang          accept TCP connections but never answer HTTP (a busy host)
 *   plugin-broken bind + 401, print the real "Failed plugins" block and no
 *                 access line until FAKE_DSH_CONFIG has {"enabled": true}
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 3900
const mode = process.env.FAKE_DSH_MODE || 'ok'
const token = 'test-token-' + 'a1b2c3d4'.repeat(3)

if (mode === 'fail') {
  console.error('YAMLException: bad indentation of a mapping entry (3:5)')
  console.error('  at load (file:///fake/cordis.patch.yml)')
  process.exit(1)
}

if (mode === 'fail-once') {
  const counter = process.env.FAKE_DSH_COUNTER || ''
  let count = 0
  try {
    count = Number(fs.readFileSync(counter, 'utf8')) || 0
  } catch {
    count = 0
  }
  fs.writeFileSync(counter, String(count + 1))
  if (count === 0) {
    console.error('YAMLException: bad indentation of a mapping entry (3:5)')
    process.exit(1)
  }
}

if (mode === 'hang') {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(port, '127.0.0.1')
  const stop = () => {
    for (const socket of sockets) socket.destroy()
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
} else {
const server = http.createServer((req, res) => {
  if (mode === 'foreign') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>another app</body></html>')
    return
  }
  res.writeHead(401, { 'content-type': 'text/plain' })
  res.end('dsh web authentication required; reopen the URL printed by dsh web.')
})

server.listen(port, '127.0.0.1', () => {
  if (mode === 'silent') return
  if (mode === 'plugin-broken') {
    /** @type {{ enabled?: boolean }} */
    let config = {}
    try {
      config = JSON.parse(fs.readFileSync(process.env.FAKE_DSH_CONFIG || '', 'utf8'))
    } catch {
      config = {}
    }
    if (config.enabled !== true) {
      const pkg = process.env.FAKE_DSH_PKG || 'dsh-demo-broken'
      process.stdout.write(
        `dsh: startup failed: 1 required plugin did not activate\n\nFailed plugins (1):\n  modules (required)\n    Package: ${pkg}\n    Error: ${pkg}: demo-config.json has enabled=false; set enabled to true\n`,
      )
      return
    }
  }
  console.log(`dsh web: http://127.0.0.1:${port}/?token=${token}`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
}
