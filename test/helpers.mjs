// @ts-check
/**
 * Shared helpers for the test suite: throw-away DSH homes, a fake install tree
 * with a `dsh` symlink, and a small poll helper.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { storeLaunchSpec, captureSelf } from '../lib/shared/launch.js'

export const here = path.dirname(fileURLToPath(import.meta.url))
export const fakeDsh = path.join(here, 'fixtures', 'fake-dsh.mjs')
export const notifySink = path.join(here, 'fixtures', 'notify-sink.mjs')

/** @returns {string} */
export function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-home-'))
}

/**
 * Build a fake DSH install: `<base>/fake-dsh/lib/bin.js` plus a `dsh` symlink so
 * `treeSnapshot()` sees a complete package tree.
 * @param {string} base
 * @returns {{ binPath: string, pkgRoot: string }}
 */
export function fakeTree(base) {
  const pkgRoot = path.join(base, 'fake-dsh')
  fs.mkdirSync(path.join(pkgRoot, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0-test' }))
  // The entry script imports the fake server, so `argv[1]` stays the dsh
  // symlink: that is what captureLaunch() records and treeSnapshot() resolves.
  fs.writeFileSync(
    path.join(pkgRoot, 'lib', 'bin.js'),
    `#!/usr/bin/env node\nimport(${JSON.stringify(fakeDsh)}).catch((error) => {\n  console.error(error)\n  process.exit(1)\n})\n`,
  )
  const binDir = path.join(base, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const binPath = path.join(binDir, 'dsh')
  fs.symlinkSync(path.join(pkgRoot, 'lib', 'bin.js'), binPath)
  return { binPath, pkgRoot }
}

/**
 * @param {string} home
 * @param {string} profile
 * @returns {string} profile dir
 */
export function profileDir(home, profile = 'web') {
  const dir = path.join(home, 'profiles', profile)
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `profile-${profile}`, private: true }))
  }
  return dir
}

/**
 * Write a launch spec that starts the fake server on `port`.
 * @param {string} instanceDir
 * @param {{ port: number, logPath: string, mode?: string, counter?: string, binPath?: string, pkgRoot?: string }} input
 */
export function writeFakeLaunch(instanceDir, { port, logPath, mode = 'ok', counter = '', binPath, pkgRoot }) {
  const self = captureSelf()
  const spec = {
    ...self,
    argv: [process.execPath, binPath || fakeDsh, 'web', '--port', String(port)],
    env: {
      ...(mode !== 'ok' ? { FAKE_DSH_MODE: mode } : {}),
      ...(counter ? { FAKE_DSH_COUNTER: counter } : {}),
    },
    cwd: instanceDir,
    nodePath: process.execPath,
    binPath: binPath || self.binPath,
    pkgRoot: pkgRoot || self.pkgRoot,
    stdoutPath: logPath,
  }
  return storeLaunchSpec(instanceDir, spec)
}

/**
 * Poll until `predicate()` is truthy.
 * @template T
 * @param {() => T} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * A port the OS just handed out: bind port 0, read the assignment, close it.
 * Random ranges collide when test files run in parallel (CI hit EADDRINUSE).
 * @param {number} [_base] kept for callers that pass a hint
 * @returns {Promise<number>}
 */
export async function freePort(_base) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('could not allocate a port'))))
    })
  })
}
