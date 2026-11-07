# dsh-restart-guard

[![ci](https://github.com/FoolishWiser/dsh-restart-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/FoolishWiser/dsh-restart-guard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-restart-guard.svg)](https://www.npmjs.com/package/dsh-restart-guard)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)

[**简体中文**](README.md) · English

A watchdog for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) that **survives the host process**, notices when a restart did not come up, decides *why* with a small set of rules, repairs what can safely be repaired, and reports what happened to the channel you configured.

It exists because the usual deployment has nobody to call: `dsh web` is started in the background, the launcher `exec`s into a proxy, and if the new process dies on a bad plugin or a broken patch the web UI stays 502 until a human notices. `dsh-restart-guard` keeps a small detached watcher alive for exactly that gap.

```text
DSH host (dsh web)                    detached watcher
┌───────────────────────┐   spawn    ┌──────────────────────────────┐
│ plugin: doctor,       │ ─────────► │ probe 127.0.0.1:<port>/ every │
│ routes, settings page │            │ 2 s, byte-offset readiness,   │
│                       │ ◄───────── │ diagnose → repair → report    │
└───────────────────────┘  state.json└──────────────────────────────┘
        │ crash/kill                          │
        ▼                                     ▼
   port goes away  ───────────────────►  restart, roll back a broken
                                          patch, or stop and tell you
```

## What it does

- **Survives the host.** The watcher is spawned detached and has no parent relationship with DSH. Killing the DSH process (SIGKILL included) does not stop it.
- **Knows what "up" means.** A 401 with DSH's auth text, or a 200 containing `__DSH_BOOT__`, counts as DSH. A generic 200 HTML page is a foreign listener and is never treated as healthy.
- **Waits for a *fresh* server.** Readiness is proved from the bytes the new process appended to the boot log (the `dsh web:` line with a token), not from the whole file — so a stale line from yesterday's log can never fake a successful restart.
- **Repairs in small, bounded steps.** Restart with the captured argv/env/cwd, roll back a broken `cordis.patch.yml` to its newest *valid* backup, or stop and hand you the evidence. At most two starts per incident, then it stops instead of thrashing.
- **Stands down for upgrades.** Six independent signals (explicit window, tree swap, sibling trees, package-manager process, `$DSH_HOME/upgrade` directory, slow boot) put it in maintenance mode: no spawn, no rollback, no kill.
- **Respects intentional stops.** A clean `exit(0)` is treated as "the operator meant it" and is not restarted.
- **Reports to where you are.** Local log always; webhooks (Feishu, WeCom, DingTalk, Slack, Telegram, Discord, ntfy, healthchecks.io, generic JSON); an arbitrary command; or the `dsh-im` plugin (IM messages are queued and delivered when the host comes back).
- **Tells you what to fix.** The settings page shows an environment report after install (boot log, patch backups, webhook/IM, supervisor, maintenance) with concrete hints, plus a crash drill so you can test the whole thing safely.

## Install

```bash
# 1. local checkout or npm
cd /path/to/dsh-restart-guard
pnpm install --ignore-scripts

# 2. link it into a profile (edits package.json with a backup, then runs pnpm)
npx dsh-restart-guard install --profile web
#    or, on npm:
#    dsh plugin --profile web add dsh-restart-guard
#    then add "dsh-restart-guard" to dsh.profile.bundles in profiles/web/package.json

# 3. restart DSH so the plugin loads (the watcher starts with it)
```

After the restart, open **Settings → Restart guard**. The report at the top lists what is still missing; fix the highlighted items there (webhook URL, IM `botId`/`targetId`, boot-log path), then press **Test notification**.

Verify from a shell:

```bash
dsh-restart-guard status      # watcher, phase, last health
dsh-restart-guard doctor      # the same checks the settings page shows
dsh-restart-guard logs -f     # follow the guard log
```

### Requirements

| Item | Requirement |
| --- | --- |
| Node | ≥ 22 |
| DSH | ≥ 0.2.1 (host plugin API, `webServer.tapIndex`) |
| OS | Linux is the fully supported target (uses `/proc`). macOS works for probing and supervision; process/port mapping falls back to `lsof`. |
| Runtime deps | none |

### Upgrading DSH

The guard is designed to be quiet during upgrades: run the upgrade as usual. If the upgrade script kills and re-launches DSH, the watcher recognises the in-flight swap (tree inode/version change, `.prev-*` sibling, `$DSH_HOME/upgrade/*`, package-manager process, restarter process) and only watches. It never starts a competing server and never rolls back files mid-swap.

## How a repair is decided

Probe fails → grace → diagnosis → plan:

| Diagnosis (first match wins) | Example in the boot log | Action |
| --- | --- | --- |
| `yaml-config` | `YAMLException`, `bad indentation` | roll back `cordis.patch.yml` to the newest backup that still composes, then start |
| `patch-incompatible` | `cannot get property "webRuntime" without inject` | first attempt: roll back; later attempts: start only |
| `wildcard-host` | `host "0.0.0.0" is an unspecified (wildcard) address` | stop; needs a config edit |
| `port-in-use` | `EADDRINUSE` | someone else owns the port: stop (optionally kill a *stale DSH* holder if enabled) |
| `module-missing` | `Cannot find module` | stop; a dependency is missing |
| `permission-disk-memory` | `EACCES`, `ENOSPC`, `ENOMEM` | stop; environment problem |
| `crash` | `Segmentation fault`, `Killed` | restart |
| `startup-failed` / `plugin-failed` | `entries did not activate`, `failed to apply loader entry` | restart |
| `stalled` | process alive, port silent past `stalledExitMs` | kill the stale holder, then start |
| `http-hanging` | port accepts TCP but HTTP never answers (auth/proxy plugin) | **notify only — never kill or restart** |
| `gateway` | entry port serves a login page (302) and the DSH core answers on `port+1/2` | **healthy**, `health.corePort` is recorded |
| `timeout` | boot did not finish in time | restart |
| `unknown` | anything else | restart |

Every incident writes `incidents/*.json`, `ALERT.md`, a log line, and (if configured) one notification per event. A crash loop (default: 3 incidents in 10 minutes) pauses the guard for 30 minutes instead of restarting forever. Two starts per incident is the ceiling.

### AI repair (optional, off by default)

When enabled the guard gains a repair channel with two modes:

- **act (default) · full permissions**: once the service is judged down, the AI is asked first — the prompt carries the **current environment** (port, host pid/uptime, node and DSH versions, profile path, `cordis.patch.yml` and its recent backups, boot-log path and size, port listeners, diagnosis and evidence, the launch command captured from `/proc`) plus the **redacted log tail**. It may read files, edit configuration, install dependencies, roll back the patch and restart the service; the guard then re-probes the port. **DSH itself is tried first** (`dsh --profile <p> headless "<prompt>"`, inheriting DSH's own model credentials and tools), then the guard's direct call (HTTP or bridge); only if both fail does the rule ladder run (restart → rollback → manual).
- **advise · verdict only**: no action rights; the model returns one JSON verdict (`retry`/`rollback-patch`/`wait`/`manual`) mapped onto the existing allow-listed actions. Model output is never executed as a command.

**Broken plugins are repaired in place.** When startup fails because of a third-party plugin (DSH prints `startup failed` / `Failed plugins` but keeps the process alive and the port still answers 401), the guard parses the failing entry and package from the log, hands the package's `package.json`, entry file and root configs to the AI, and asks for `fix-plugin` (full contents of 1–3 files). The guard validates the paths (inside the package, ≤64 KiB, no symlinks), backs up every file (`.guard-bak-<ts>`), checks syntax (`node --check` / `JSON.parse`), and only then boots DSH again; any failure restores everything. If the file cannot be fixed, the verdict falls back to `disable-plugin` (disable the loader entry) or `manual`. Core packages (`@deepseek-ai/*` and this plugin) are never editable, and the settings page offers **Undo AI repair**.

Safety: a maintenance window, an incomplete package tree, or a real supervisor (systemd/pm2) still stops the AI from acting; the log tail is redacted, environment variables are sent as **key names only**, and secrets or access tokens never leave the machine. Nothing is sent while AI repair is off. Hard stops and a foreign port holder are never overridden.

Enable it under **Settings → Restart guard → AI repair**, pick the mode and order (`dsh-agent-first` / `direct-first` / `dsh-agent-only` / `direct-only`), then the provider and key source. **By default the guard borrows the harness's own credential** (`refs:` in `$DSH_HOME/.credentials.yaml`: `DEEPSEEK_API_KEY`, `XIAOMI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), so AI repair keeps working while `dsh web` itself is down; narrow it with `ai.credentialSource` (`env`/`dsh`/`none`) or `ai.keyRef`. Keys are read-only and never written to the config or the log.

`ai.dshAgent` tunes the "DSH itself" channel (`command` defaults to `dsh`, `args` to `["headless"]`, `timeoutMs` to 300000). If the guard should not call a model API directly, enable **bridging** (`ai.bridge`): the prompt goes to a program's stdin and the verdict comes back on stdout. Use **Test AI** or `dsh-restart-guard ai-test` to check the wiring.

## Configuration

Global file: `$DSH_HOME/restart-guard/config.json` (mode 0600). Everything can be edited from the settings page or with your editor; the watcher reloads it automatically.

```jsonc
{
  "enabled": true,
  "locale": "auto",
  "watchdog": {
    "probeIntervalMs": 2000,
    "probeTimeoutMs": 3000,
    "startupGraceMs": 30000,
    "bootTimeoutMs": 120000,
    "settleMs": 5000,
    "stalledExitMs": 20000,
    "hangConfirmMs": 20000,
    "maxRestartAttempts": 2,
    "rollbackProfilePatch": true,
    "killStaleDshHolder": false,
    "respectIntentionalStop": true,
    "autoResumeAfterPauseMs": 600000,
    "crashLoop": { "windowMs": 600000, "maxIncidents": 3, "pauseMs": 1800000 }
  },
  "maintenance": { "autoDetect": true, "graceMs": 900000, "lookbackMs": 1800000 },
  "readiness": { "accessLine": "dsh web:", "fatalPatterns": ["failed to mount", "Cannot find module"] },
  "logs": { "bootLogPath": "", "mirrorToHostLog": true },
  "ai": {
    "enabled": false, "preset": "deepseek", "endpoint": "", "model": "",
    "keyEnv": "DEEPSEEK_API_KEY", "keyRef": "", "credentialSource": "auto",
    "bridge": { "enabled": false, "program": "", "args": [] }
  },
  "notify": {
    "webhook": { "enabled": false, "preset": "generic", "url": "" },
    "command": { "enabled": false, "program": "", "args": [] },
    "im": { "enabled": false, "botId": "", "targetId": "", "format": "markdown" }
  },
  "supervision": { "mode": "auto" },
  "security": { "allowRemoteMutations": false, "dangerousActions": false }
}
```

`bootLogPath` is usually unnecessary: the guard captures the real stdout from `/proc/<pid>/fd/1` while the host is healthy. Set it if stdout is a pipe (for example, a launcher that captures output itself).

`logs.mirrorToHostLog` (default `true`) echoes every guard line into the host's own stdout (the `bootLogPath` or the captured stdout file) behind a `[dsh-restart-guard] ` prefix. In a container that means `docker logs` shows who is repairing what without opening a shell; the prefix cannot be mistaken for the server's own access line.

`supervision.mode` controls who is assumed to own restarts: `auto` (default) sniffs systemd, pm2, supervisord and containers; `none` tells the guard nobody else will restart DSH, so it acts even if the environment looks managed (useful in CI, or a container whose PID 1 is systemd but which does not restart the server); `supervised` forces report-only when detection cannot see the real owner.

### Scheduled / container deployments

- The guard writes its state to `$DSH_HOME/restart-guard/`; that directory must survive restarts.
- If a supervisor (systemd, pm2, …) already restarts DSH, the guard detects it and only reports — it will not race the supervisor for the port.
- If a container launcher restarts DSH on its own, the guard sees the port come back during arbitration and waits instead of spawning a second server.

## Channels

| Channel | Configure | Notes |
| --- | --- | --- |
| log | always on | `$DSH_HOME/restart-guard/instances/<profile>-<port>/restart-guard.log`, rotated at 5 MB, 2 files |
| webhook | `notify.webhook` or `DSH_RESTART_GUARD_WEBHOOK_URL` | presets: `feishu`, `wecom`, `dingtalk`, `slack`, `telegram`, `discord`, `ntfy`, `healthchecks`, `generic` |
| command | `notify.command` | argv is executed directly (no shell); the message is written to stdin |
| IM | `notify.im` (`botId`/`targetId`) or `DSH_RESTART_GUARD_IM_BOT_ID`/`_TARGET_ID` | requires the `dsh-im` plugin; undeliverable messages are queued and replayed by the host |

Messages are throttled (60 s per event), include a log tail (40 lines by default) with tokens and cookies redacted, and never include the launch token or access URL unless you explicitly turn those on.

## CLI

```text
dsh-restart-guard status [--json]      watcher/phase/health summary
dsh-restart-guard doctor               environment report + hints
dsh-restart-guard logs [-f] [-n N]     guard log
dsh-restart-guard incidents            recent incidents
dsh-restart-guard outbox               queued IM messages
dsh-restart-guard restart|start|rollback|simulate-crash
dsh-restart-guard pause --minutes 30   suspend repairs
dsh-restart-guard resume
dsh-restart-guard maintenance start|end [--minutes 60] [--reason upgrade]
dsh-restart-guard notify-test          send a test message
dsh-restart-guard ai-test              ask the configured AI for a verdict (no action)

**Reproduce the broken-plugin demo** (isolated port 3098, the live 3079 is untouched):

```bash
demo/run.sh          # deterministic: a stub bridge returns fix-plugin
demo/run.sh --real   # real model through DSH's own credentials
demo/run.sh --keep   # keep the instance; finish with demo/stop.sh
```

The demo registers a real third-party plugin under a required loader id; the plugin throws while its `demo-config.json` says `enabled: false`, and the host is killed. The guard should notice "401 on the port but the boot failed", kill the half-started process, ask the AI, flip `enabled` back to `true` and boot again.
dsh-restart-guard reload               reload config
dsh-restart-guard install|uninstall [--profile web] [--dry-run]
dsh-restart-guard purge                delete all guard state
```

The CLI talks to the watcher through control files (it never needs the session token). Actions that require a live watcher exit with code 3 when it is not running.

## Security and privacy

- No telemetry. With no channel configured the guard makes **zero outbound connections**.
- The settings API is protected by a per-page token injected into the app shell; mutations are POST-only, allow-listed, and remote callers are rejected unless `security.allowRemoteMutations` is set.
- Secrets (webhook URLs, IM ids, tokens in logs) are redacted before they reach a log line or a notification. Environment variable *values* are never stored, only their names.
- Data lives under `$DSH_HOME/restart-guard/` with `0700` directories and `0600` files; nothing is written through symlinks.

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| no watcher | `dsh-restart-guard status`; the host plugin starts it within 10 s of boot. Look for `watcher-spawn` in the plugin log. |
| started, but nothing on the port | the report's `boot-log` check: without a captured stdout the guard can still verify over HTTP, but cannot confirm a fresh token. |
| does not restart | `maintenance` or `supervisor` in the status: expected during upgrades / under systemd. |
| repeated restarts | the state file shows the diagnosis; fix it, then `resume`. |
| IM silent | botId/targetId copied from Settings → IM Bot; use **Test notification** first. |

> A QQ bot only exposes its `Bot ID`: leave `targetId` empty and the guard uses the bot's single saved target automatically. If it has none yet, message the bot once (or add it to a group), create a target in dsh-im, then rescan on the settings page.

More in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Development

```bash
pnpm install --ignore-scripts
pnpm run typecheck      # tsc --noEmit, no build step
pnpm test               # node:test, including e2e against a fake dsh
pnpm run build:client   # rebuild lib/client.js from src/client.jsx
node scripts/build-client.mjs --check   # CI: bundle is committed and current
```

Architecture and invariants: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
