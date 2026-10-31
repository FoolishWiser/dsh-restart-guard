# dsh-restart-guard

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
| `timeout` | boot did not finish in time | restart |
| `unknown` | anything else | restart |

Every incident writes `incidents/*.json`, `ALERT.md`, a log line, and (if configured) one notification per event. A crash loop (default: 3 incidents in 10 minutes) pauses the guard for 30 minutes instead of restarting forever. Two starts per incident is the ceiling.

### AI-assisted repair (optional, off by default)

When the rule ladder has no safe move left (a foreign port holder, a missing module, an unfamiliar startup failure), the watcher can ask an LLM for a second opinion. The model receives only the **redacted boot-log tail** and facts that are already public (diagnosis, attempt number, port, profile, supervisor kind, patch-backup count, versions). It must answer with one JSON verdict:

```json
{ "action": "retry | rollback-patch | wait | manual", "reason": "…", "hint": "…", "confidence": 0.0 }
```

The verdict is mapped onto the existing allow-listed actions — the guard never executes model output as a command. Additionally:

- hard stops (maintenance window, incomplete tree, supervisor-owned process, foreign port holder) are never overridden;
- a verdict below `0.5` confidence is treated as `manual`;
- `retry` is refused when a non-DSH process owns the port;
- `rollback-patch` only applies when a backup exists and no rollback was tried yet;
- if the call fails (no key, timeout, HTTP error, bad JSON) the rule-based decision stands and `ai-unavailable` is logged.

Enable it under **Settings → Restart guard → AI-assisted repair**, set the provider (`deepseek`, `openai` or a custom OpenAI-compatible endpoint), the model, and the **name of an environment variable** holding the key (default `DEEPSEEK_API_KEY`; the key itself is never written to the config). Use **Test AI** to check the wiring; `dsh-restart-guard ai-test` does the same from a shell. The prompts and responses are not logged beyond the verdict summary, and no data leaves the machine unless you turn this on.

### What is *not* repaired automatically

- A port owned by a **non-DSH** process. The guard reports it, never kills it.
- Anything during a maintenance window or with an incomplete package tree.
- A wildcard bind, a missing module, or a permission problem: these need a human, so it says so.
- A clean stop (`exit(0)`) when `respectIntentionalStop` is on.

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
    "maxRestartAttempts": 2,
    "rollbackProfilePatch": true,
    "killStaleDshHolder": false,
    "respectIntentionalStop": true,
    "crashLoop": { "windowMs": 600000, "maxIncidents": 3, "pauseMs": 1800000 }
  },
  "maintenance": { "autoDetect": true, "graceMs": 900000, "lookbackMs": 1800000 },
  "readiness": { "accessLine": "dsh web:", "fatalPatterns": ["failed to mount", "Cannot find module"] },
  "logs": { "bootLogPath": "" },
  "ai": { "enabled": false, "preset": "deepseek", "endpoint": "", "model": "", "keyEnv": "DEEPSEEK_API_KEY" },
  "notify": {
    "webhook": { "enabled": false, "preset": "generic", "url": "" },
    "command": { "enabled": false, "program": "", "args": [] },
    "im": { "enabled": false, "botId": "", "targetId": "", "format": "markdown" }
  },
  "security": { "allowRemoteMutations": false, "dangerousActions": false }
}
```

`bootLogPath` is usually unnecessary: the guard captures the real stdout from `/proc/<pid>/fd/1` while the host is healthy. Set it if stdout is a pipe (for example, a launcher that captures output itself).

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
