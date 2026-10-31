// @ts-check
/**
 * Local installation into a DSH profile.
 *
 * DSH loads a plugin when two things are true: the profile depends on it, and
 * the bundle name is listed in `dsh.profile.bundles`. This module edits only the
 * profile's `package.json` (with a backup) and lets pnpm materialize the link;
 * it never touches `cordis.patch.yml`, which belongs to the operator.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { dshHome, writeJsonAtomic } from './shared/paths.js'

const PLUGIN = 'dsh-restart-guard'

/**
 * @param {{ env: Record<string, string | undefined>, profile: string, root: string, dryRun?: boolean }} input
 */
export function install({ env, profile, root, dryRun = false }) {
  const profileDir = profileDirFor(env, profile)
  const pkgFile = path.join(profileDir, 'package.json')
  const pkg = readPackage(pkgFile)
  /** @type {string[]} */
  const hints = []

  pkg.dependencies ??= {}
  pkg.dependencies[PLUGIN] = `link:${root}`
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (!bundles.includes(PLUGIN)) bundles.push(PLUGIN)
  pkg.dsh.profile.bundles = bundles

  hints.push(`profile: ${profileDir}`)
  hints.push(`bundle order: ${bundles.join(', ')}`)
  if (dryRun) {
    hints.push('dry run: package.json was not rewritten and pnpm was not run')
    return { ok: true, profileDir, hints }
  }

  backup(pkgFile)
  writeJsonAtomic(pkgFile, pkg, 0o644)
  const installResult = runPnpm(profileDir, env)
  if (!installResult.ok) hints.push(`pnpm install failed: ${installResult.detail}`)
  const linked = path.join(profileDir, 'node_modules', PLUGIN)
  hints.push(fs.existsSync(linked) ? `linked: ${linked}` : `NOT linked yet: run \`pnpm install\` in ${profileDir}`)
  hints.push('restart DSH (e.g. `dsh web --port <port>`) so the host plugin loads and starts the watcher')
  hints.push('then open Settings → Restart guard and finish the environment hints there')
  return { ok: installResult.ok, profileDir, hints }
}

/**
 * @param {{ env: Record<string, string | undefined>, profile: string }} input
 */
export function uninstall({ env, profile }) {
  const profileDir = profileDirFor(env, profile)
  const pkgFile = path.join(profileDir, 'package.json')
  const pkg = readPackage(pkgFile)
  /** @type {string[]} */
  const hints = []
  if (pkg.dependencies && PLUGIN in pkg.dependencies) delete pkg.dependencies[PLUGIN]
  const bundles = pkg.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    pkg.dsh.profile.bundles = bundles.filter((/** @type {string} */ name) => name !== PLUGIN)
  }
  backup(pkgFile)
  writeJsonAtomic(pkgFile, pkg, 0o644)
  const result = runPnpm(profileDir, env)
  if (!result.ok) hints.push(`pnpm install failed: ${result.detail}`)
  hints.push('state under $DSH_HOME/restart-guard is kept; run `dsh-restart-guard purge` to delete it')
  return { ok: result.ok, profileDir, hints }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} profile
 */
function profileDirFor(env, profile) {
  const dir = path.join(dshHome(env), 'profiles', profile)
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`DSH profile "${profile}" not found at ${dir}`)
  }
  return dir
}

/** @param {string} file */
function readPackage(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** @param {string} file */
function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.guard-bak-${stamp}`
  fs.copyFileSync(file, target)
  return target
}

/**
 * @param {string} cwd
 * @param {Record<string, string | undefined>} env
 */
function runPnpm(cwd, env) {
  const pnpm = env.DSH_RESTART_GUARD_PNPM || 'pnpm'
  const result = spawnSync(pnpm, ['install'], {
    cwd,
    env: { ...env },
    stdio: 'inherit',
    timeout: 10 * 60_000,
  })
  return {
    ok: result.status === 0,
    detail: result.error ? String(result.error) : `exit ${result.status}`,
  }
}
