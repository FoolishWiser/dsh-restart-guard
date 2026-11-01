// @ts-check
/**
 * Environment briefing for the AI repair agent.
 *
 * The prompt is only as useful as the situation it describes, so this module
 * collects the facts a human operator would look at first: what is running on
 * the port, which tree and patch the profile uses, where the boot log lives,
 * who supervises us, and what the guard already saw. Secret values never leave
 * this module: environment variables are reduced to their names and argv is
 * passed through the redactor.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dshHome, guardRoot, configPath as guardConfigPath, instanceDir } from './paths.js'
import { findPidsByPort, pidCmdline, processStartTimeMs, httpProbe } from './probe.js'
import { envKeyNames, redactArgv, maskUrl } from './redact.js'
import { loadLaunchSpec } from './launch.js'

/**
 * @typedef {{
 *   generatedAt: number, port: number, profile: string, os: string, arch: string,
 *   node: string, dshVersion: string, dshBin: string, dshHome: string, profileDir: string,
 *   home: string, user: string, cwd: string, guardVersion: string, guardDir: string,
 *   guardConfig: string, launch: Record<string, any> | null, listeners: Array<{ pid: number, cmdline: string }>,
 *   portOpen: boolean, supervisor: string, supervisorDetail: string, maintenance: string,
 *   patchPath: string, patchExists: boolean, patchMtime: string, patchBackups: string[],
 *   bootLogPath: string, bootLogSize: number, health: string, incident: string,
 *   detail: string, evidence: string[], hostPid: number, hostUptimeMs: number,
 *   sessionId: string, envKeys: string[], heartbeat: string,
 * }} EnvironmentFacts
 */

/** @param {string} dir */
function listBackups(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('cordis.patch.yml.bak') || name.startsWith('cordis.patch.yml.guard-broken'))
      .sort()
      .slice(-6)
  } catch {
    return []
  }
}

/**
 * @param {{
 *   env: Record<string, string | undefined>, port: number, profile: string,
 *   instanceDir: string, guardVersion?: string, supervisor?: any, maintenance?: any,
 *   state?: any, diagnosis?: any, dshVersion?: string,
 * }} input
 * @returns {Promise<EnvironmentFacts>}
 */
export async function buildEnvironment(input) {
  const env = input.env
  const home = dshHome(env)
  const profileDir = path.join(home, 'profiles', input.profile)
  const launch = loadLaunchSpec(input.instanceDir)
  const listeners = []
  const owners = findPidsByPort(input.port)
  for (const pid of owners.pids.slice(0, 4)) {
    const argv = pidCmdline(pid)
    listeners.push({ pid, cmdline: redactArgv(argv || []).join(' ') })
  }
  let portOpen = false
  try {
    const probe = await httpProbe({ port: input.port, timeoutMs: 1500 })
    portOpen = probe.status > 0 || probe.kind === 'dsh' || probe.kind === 'foreign'
  } catch {
    portOpen = false
  }
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  let patchExists = false
  let patchMtime = ''
  let bootLogSize = 0
  try {
    const stat = fs.statSync(patchPath)
    patchExists = true
    patchMtime = stat.mtime.toISOString()
  } catch {
    /* no patch layer */
  }
  const bootLog = String(input.state?.boot?.logPath ?? launch?.stdoutPath ?? '')
  if (bootLog) {
    try {
      bootLogSize = fs.statSync(bootLog).size
    } catch {
      bootLogSize = 0
    }
  }
  const hostPid = Number(input.state?.host?.pid ?? 0)
  const since = Number(input.state?.host?.startedAt ?? 0)
  const bootTime = since > 0 ? processStartTimeMs(hostPid) : 0
  const dshVersion = String(input.dshVersion ?? input.state?.host?.version ?? '')
  const dshBin = String(launch?.binPath ?? 'dsh')
  const incident = input.diagnosis ?? {}
  return {
    generatedAt: Date.now(),
    port: input.port,
    profile: input.profile,
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    dshVersion,
    dshBin,
    dshHome: home,
    profileDir,
    home: env.HOME ?? '',
    user: env.USER ?? env.LOGNAME ?? '',
    cwd: String(launch?.cwd ?? process.cwd()),
    guardVersion: String(input.guardVersion ?? ''),
    guardDir: input.instanceDir,
    guardConfig: guardConfigPath(env),
    launch: launch
      ? { argv: redactArgv(launch.argv ?? []), cwd: launch.cwd, nodePath: launch.nodePath, stdoutPath: launch.stdoutPath, capturedAt: launch.capturedAt }
      : null,
    listeners,
    portOpen,
    supervisor: String(input.supervisor?.kind ?? 'unknown'),
    supervisorDetail: String(input.supervisor?.detail ?? ''),
    maintenance: input.maintenance?.active ? String(input.maintenance.signal ?? 'active') : 'none',
    patchPath,
    patchExists,
    patchMtime,
    patchBackups: listBackups(profileDir),
    bootLogPath: bootLog,
    bootLogSize,
    health: input.state?.health ? `${input.state.health.ok ? 'ok' : 'down'} ${input.state.health.kind ?? ''} ${input.state.health.error ?? ''}`.trim() : 'unknown',
    incident: String(incident.incident ?? 'unknown'),
    detail: String(incident.detail ?? ''),
    evidence: Array.isArray(incident.evidence) ? incident.evidence.slice(0, 6).map(String) : [],
    hostPid,
    hostUptimeMs: bootTime > 0 ? Date.now() - bootTime : 0,
    sessionId: String(env.DSH_SESSION_ID ?? ''),
    envKeys: envKeyNames(env),
    heartbeat: input.state?.updatedAt ? new Date(Number(input.state.updatedAt)).toISOString() : '',
  }
}

/** @param {number} ms */
function human(ms) {
  if (!ms || ms < 0) return 'unknown'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/**
 * Markdown briefing embedded in the AI prompt.
 * @param {EnvironmentFacts} facts
 */
export function renderEnvironment(facts) {
  const lines = [
    '## Environment',
    `- time: ${new Date(facts.generatedAt).toISOString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'})`,
    `- host: ${facts.os} ${facts.arch}, node ${facts.node}, user ${facts.user || 'unknown'}, cwd ${facts.cwd}`,
    `- guard: dsh-restart-guard ${facts.guardVersion} at ${facts.guardDir}`,
    `- dsh: version ${facts.dshVersion || 'unknown'}, binary ${facts.dshBin}, DSH_HOME ${facts.dshHome}, profile ${facts.profile} (${facts.profileDir})`,
    `- service: port ${facts.port}, port open: ${facts.portOpen ? 'yes' : 'no'}, host pid ${facts.hostPid || 'unknown'} (uptime ${human(facts.hostUptimeMs)})`,
    `- supervisor: ${facts.supervisor}${facts.supervisorDetail ? ` (${facts.supervisorDetail})` : ''}, maintenance: ${facts.maintenance}`,
    `- last health probe: ${facts.health}`,
    `- patch layer: ${facts.patchPath} ${facts.patchExists ? `(mtime ${facts.patchMtime})` : '(missing)'}`,
    `- patch backups: ${facts.patchBackups.length ? facts.patchBackups.join(', ') : 'none'}`,
    `- boot log: ${facts.bootLogPath || 'unknown'}${facts.bootLogSize ? ` (${facts.bootLogSize} bytes)` : ''}`,
    `- guard config: ${facts.guardConfig}`,
    `- launch spec: ${facts.launch ? `argv ${JSON.stringify(facts.launch.argv)} cwd ${facts.launch.cwd}` : 'not captured yet'}`,
    `- listeners on ${facts.port}: ${facts.listeners.length ? facts.listeners.map((l) => `pid ${l.pid} :: ${l.cmdline}`).join('; ') : 'none'}`,
    `- diagnosis: ${facts.incident}${facts.detail ? ` — ${facts.detail}` : ''}`,
    ...(facts.evidence.length ? ['- evidence:', ...facts.evidence.map((line) => `  - ${line}`)] : []),
    `- session id: ${facts.sessionId || 'unknown'}`,
  ]
  return lines.join('\n')
}

/** Human-readable one-liner for logs/plans. @param {EnvironmentFacts} facts */
export function summarizeEnvironment(facts) {
  return `port=${facts.port} profile=${facts.profile} node=${facts.node} dsh=${facts.dshVersion || '?'} owner=${facts.supervisor} log=${facts.bootLogPath ? maskUrl(facts.bootLogPath) : 'unknown'}`
}
