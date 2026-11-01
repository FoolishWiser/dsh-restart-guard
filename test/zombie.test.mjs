// @ts-check
/**
 * A killed child of a process that never reaps (PID 1 in many containers)
 * stays as a zombie: `kill -0` still succeeds but it serves no port and can
 * never be killed. The guard must treat that as "gone", not as a stalled host.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { isZombie, pidAlive, pidCmdline, pidGone, readProcessState } from '../lib/shared/probe.js'
import { waitFor } from './helpers.mjs'

const linux = process.platform === 'linux'
const python = linux && spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0

test('a zombie counts as gone, not as a live host', { skip: !python, timeout: 20000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-zombie-'))
  const pidFile = path.join(tmp, 'child.pid')
  // A shell reaps its background children; Python does not, so killing the
  // child leaves the real `/proc/<pid>` zombie a container PID 1 produces.
  const script = [
    'import subprocess, sys, time',
    'child = subprocess.Popen(["sleep", "300"])',
    'open(sys.argv[1], "w").write(str(child.pid))',
    'time.sleep(300)',
  ].join('\n')

  const parent = spawn('python3', ['-c', script, pidFile], { stdio: 'ignore' })
  try {
    await waitFor(() => (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() ? true : null), {
      timeoutMs: 5000,
      intervalMs: 50,
      label: 'zombie child pid',
    })
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    assert.ok(pid > 0)
    assert.equal(pidAlive(pid), true, 'the child is alive before the kill')

    process.kill(pid, 'SIGKILL')
    await waitFor(() => (isZombie(pid) ? true : null), { timeoutMs: 5000, intervalMs: 50, label: 'zombie state' })

    assert.equal(readProcessState(pid).zombie, true)
    assert.equal(pidAlive(pid), false, 'a zombie is not a live host')
    assert.deepEqual(pidCmdline(pid), [], 'a zombie has no command line')
    assert.equal(pidGone(pid), true)
  } finally {
    parent.kill('SIGKILL')
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
