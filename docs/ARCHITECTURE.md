# Architecture

```
lib/
  index.js            host plugin: routes, settings API, watcher supervision, outbox replay
  watcher.mjs         detached daemon: probe → diagnose → repair → notify
  repair.js           spawn/verify/rollback/kill primitives
  doctor.js           environment report used by the settings page and the CLI
  install.mjs         profile install/uninstall
  cli.mjs             operator CLI (control files, no HTTP)
  client.js           prebuilt browser bundle (generated from src/client.jsx)
  shared/
    paths.js          $DSH_HOME layout, atomic writes, O_NOFOLLOW appends
    config.js         defaults, validation, per-instance config load/save
    state.js          state/pid/control/incident/outbox files
    probe.js          HTTP probe, /proc process + port mapping, liveness
    diagnose.js       boot-failure classifier, access-line and audit parsing
    plan.js           rule-based repair plans
    maintenance.js    upgrade/maintenance detection (six signals)
    supervision.js    systemd/pm2/docker detection
    launch.js         launch-spec capture and environment filtering
    notify.js         message building, webhook/command/IM delivery
    ai.js             optional LLM verdict, validated and mapped onto actions
    redact.js         secret masking for logs and notifications
    log.js            rotating, redacting guard log
    http.js           request body limits, JSON responses, guard token
```

## Two processes, no shared writes

The host plugin and the watcher never write the same file:

| Direction | Files |
| --- | --- |
| host → watcher | `pid.json`, `control/exit.json`, `control/requests/*.json` |
| watcher → host/operator | `state.json`, `watcher.json`, `control/plan.json`, `control/results/*.json`, `incidents/`, `outbox/`, `ALERT.md`, `restart-guard.log` |

The host starts the watcher with `spawn(node, [watcher.mjs, --home, --profile, --port, --instance], { detached: true, stdio: 'ignore' })` and immediately unrefs it. There is no pipe, no IPC socket, no parent-child signal relationship: killing the host leaves the watcher running, and killing the watcher is repaired by the host on its next 10-second tick (with a spawn budget of 6 per 10 minutes).

Supervision is detected (systemd/pm2 env markers, parent comm, PID 1, container cgroups) and can be overridden with `supervision.mode`: `none` forces "nobody else restarts DSH" (CI, or a container with a foreign init), `supervised` forces report-only.

A single `watcher.lock` (O_EXCL) prevents two watchers for one instance. A live watcher with a different version is replaced (`--replace` → `control/stop` → 500 ms wait) so upgrades converge.

## Health and readiness

Two separate questions:

1. **Is something answering?** A `GET /` that returns `401` with `dsh web authentication required…`, or `200` with `__DSH_BOOT__`, is DSH. Any other `200`/`302`/`403` is a *foreign* listener: reported, never killed, never treated as healthy. A connection error is *down*; a timeout while the TCP port still accepts connections is *slow* (`portOpen` is true) and is **not** treated as a failure — the guard would otherwise restart a busy but alive server.
2. **Did *this* process really come up?** The boot log is read from the byte offset recorded immediately before `spawn`. Only bytes written after that point count. Readiness requires the `dsh web: …/?token=…` access line in that segment, followed by `settleMs` of continued health. Reading the whole file is forbidden by design: a stale line from the previous boot would both fake readiness and fetch an expired token.

When stdout is a pipe (no file), the guard can still confirm HTTP health after `readiness.inferredSettleMs` of consecutive successful probes, and marks the result `ready-without-access-line` so the report tells you the token cannot be confirmed.

## Incident lifecycle

```
monitoring ──(probe fails, grace passed)──► diagnosing ──► restarting ──► verified ──► monitoring
     ▲                                             │                        │
     │                                             └──► manual (stop + alert)│
     └──────────── maintenance / paused / supervised / stopped ◄─────────────┘
```

- **Guard grace**: `startupGraceMs` after a restart or after the guard itself starts.
- **Arbitration**: if a restarter-looking process is running or the port comes back during the grace, the guard extends it (`arbitration.extraGraceMs`, at most `maxExtensions`) instead of racing.
- **Intentional stop**: the host writes `control/exit.json {ts, code}` in `process.once('exit')`. A clean code plus no respawn within 45 s means `stopped`.
- **Crash loop**: 3 incidents in 10 minutes → `control/pause` for 30 minutes and a `flapping` notification.
- Every incident ends in `monitoring` (resolved automatically or externally) or `manual` (stopped with `ALERT.md`, an incident record and a notification).

## Repair plan

`plan.js` is pure: given a diagnosis, attempt number, config, maintenance state, supervisor state and port occupant, it returns an ordered step list. The watcher only executes the allow-listed actions (`rollback-patch`, `kill-stale`, `start-dsh`, `verify`, `manual`, `notify`).

Safety invariants, in order:

1. maintenance / incomplete tree / supervisor → hold, never spawn.
2. a foreign port holder → manual, never kill.
3. wildcard bind / missing module / permission problem → manual with a specific hint.
4. rollback only on patch-related diagnoses, only on the first attempt, and only for a backup that passes `dsh --dump-config`.
5. at most `maxRestartAttempts` starts per incident; 3 s apart.
6. the AI verdict (when enabled) may only *convert a manual stop into retry/rollback* under the rules in `ai.js`, never into a shell command, and never past rules 1–3.

## Maintenance and upgrades

`detectMaintenance` combines independent signals and returns `{active, signal, until, treeIntact, …}`:

- an explicit `control/maintenance.json` window;
- the package tree's version/inode/mtime changed since the baseline;
- sibling trees `<pkgRoot>.prev-*`, `.new`, `.failed-*` — only if touched within `lookbackMs` (stale leftovers from last month must not park the guard forever);
- a package-manager process (`pnpm|npm|yarn` install/add);
- the newest `$DSH_HOME/upgrade/<ts>` directory, with terminal state read from `result*.json` / `status.jsonl` / `SUMMARY.md`;
- a slow boot.

While active, the guard writes nothing destructive: no spawn, no rollback, no kill. If the tree is still incomplete when the window expires, it reports `tree-incomplete` and refuses to start rather than running a half-swapped installation.

## Settings API

Routes are registered with `ctx.webServer.register({kind:'exact', path})` under `/api/restart-guard/`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/state` | config (redacted), watcher, state, plan, maintenance |
| GET | `/doctor` | environment report + hints (10 s cache) |
| GET | `/incidents` | recent incidents |
| POST | `/config` | validated patch of known top-level keys |
| POST | `/action` | allow-listed action, delivered to the watcher through `control/requests` |
| POST | `/ai-test` | one AI call, verdict returned, nothing executed |

Auth is a per-boot random token injected into the shell HTML through `tapIndex`; the browser bundle reads it from a `<meta>` tag. See [SECURITY.md](../SECURITY.md).

## Testing strategy

- Pure functions get unit tests (`paths`, `config`, `redact`, `diagnose`, `plan`, `maintenance`, `probe`, `doctor`, `install`, `ai`).
- `test/fixtures/fake-dsh.mjs` impersonates `dsh web` in several modes (`ok`, `fail`, `fail-once`, `foreign`, `silent`, `hang`); `repair.js` and the watcher are exercised end-to-end against it, including readiness from byte offsets, patch rollback through a fake `--dump-config`, a SIGKILL repair cycle, the slow-host case and the maintenance stand-down.
- `scripts/build-client.mjs --check` keeps the committed browser bundle honest.
