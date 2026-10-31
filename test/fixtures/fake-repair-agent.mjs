// @ts-check
/**
 * Stand-in for "the DSH agent repairs it": starts the fake DSH web server on the
 * requested port, waits for the 401, prints the VERDICT line and exits 0.
 */
import { spawn } from 'node:child_process'

const port = Number(process.env.FAKE_DSH_PORT || 0)
const bin = process.env.FAKE_DSH_BIN || ''
const log = process.env.FAKE_DSH_LOG || ''
if (!port || !bin) {
  console.error('fake-repair-agent: FAKE_DSH_PORT and FAKE_DSH_BIN are required')
  process.exit(2)
}

const out = log ? (await import('node:fs')).openSync(log, 'a') : 'ignore'
const child = spawn(process.execPath, [bin, 'web', '--port', String(port)], {
  detached: true,
  stdio: ['ignore', out, out],
  env: { ...process.env, FAKE_DSH_MODE: 'ok' },
})
child.unref()

const deadline = Date.now() + 15000
while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
    if (response.status === 401) {
      console.log('started the service again')
      console.log('VERDICT {"action":"fixed","reason":"started dsh web on the configured port","hint":"none","confidence":0.95}')
      process.exit(0)
    }
  } catch {
    /* keep waiting */
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
console.error('fake-repair-agent: the service never answered')
process.exit(1)
