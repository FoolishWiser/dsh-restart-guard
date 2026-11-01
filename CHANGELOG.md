## [0.1.6] — 2026-11-01

### Fixed

- The log mirror no longer falls back to a hard-coded `/app/.dsh-web.log`.
  It asks the live host for `/proc/<pid>/fd/1`, so a second instance started on
  another port cannot append into the production container log.
- `state.diagnostics.mirrorPath` is refreshed when the host changes instead of
  being frozen at watcher start.
- The AI repair briefing reports the boot log path the repair actually reads
  instead of `log=unknown`.

## [0.1.5] — 2026-11-01

### Fixed

- A killed host whose parent never reaps it (PID 1 in many containers) stays
  as a zombie: `kill -0` still succeeds, so the guard called it "stalled",
  tried to stop it, was refused because the cmdline is `[defunct]`, and gave up
  in `manual` without ever starting a replacement. Zombies now count as gone
  (`pidAlive` is false, `pidCmdline` is empty), the stalled verdict requires a
  live `dsh web` process, and `kill-stale` is skipped instead of failing the
  repair when there is nothing to kill.
- The `simulate-crash` drill marks the stop it performs and restarts
  immediately instead of waiting out the stalled timeout.
- Two watchers could run at once after a hand-over: the successor cleared the
  predecessor's stop before the predecessor read it. Stops are now addressed to
  one pid, the successor leaves them alone, and every watcher checks that it
  still owns `watcher.lock` (and exits as `lock-lost` when it does not). The
  lock file is no longer deleted while its owner may still be writing it.
- The host plugin spawns the watcher single-flight and verifies that the new
  pid took over, so `ready` and the ten-second tick cannot spawn two.
- The guard finds a mirror target in container layouts (`/app/.dsh-web.log`
  fallback) and reports `log=unknown` instead of `log=?`.
- `ALERT.md` is removed when an incident resolves successfully, so a drill that
  recovered does not leave a stale "not responding" file behind.

## [0.1.4] — 2026-10-31

### Fixed

- Maintenance mode notified on every probe tick while the host was down: the
  maintenance branch used the incident-scoped dedupe map, which never exists
  during a maintenance window. It now dedupes on the signal set and clears the
  marker when the window ends.
- The maintenance deadline slid forward on every probe (`now + graceMs`), so a
  lingering restarter kept extending the window and changed the message each
  time. Windows are now anchored: the same signal keeps its original deadline,
  and explicit windows end exactly when asked.
- `appendOutbox` collapses identical reports for ten minutes, so a queue
  accumulated while the host was down cannot flood a channel on replay.

## [0.1.3] — 2026-10-31

### Added
- **AI 修复（完全权限）**：`ai.mode: "act"`（默认）让 AI 直接处理故障——提示词附带完整环境简报（端口、宿主、profile、补丁备份、日志路径、监听者、诊断证据、启动命令）+ 脱敏日志尾部；AI 可改配置、装依赖、回滚 patch、重启服务，之后守护复验端口，失败仍回退规则阶梯。`"advise"` 保留原来的闭集判定。
- **先 dsh 本体、再插件直连**：`ai.order`（`dsh-agent-first`/`direct-first`/`dsh-agent-only`/`direct-only`），`ai.dshAgent` 控制 `dsh --profile <p> headless` 通道（command/args/timeout）。
- **IM 只给 botId 也能用**：`notify.im.targetId` 可留空，守护在该 bot 只有一个目标时自动解析；多个目标或无目标时给出明确提示（QQ 只提供 Bot ID 的场景）。
- `maintenance-end`：服务恢复健康后立即退出维护相位，不再干等窗口结束。

### Fixed
- 体检里 `ai` 检查改为按模式判断（act + dsh agent 时无需 API key），并显示 mode/order；`im` 检查按自动目标解析结果判断。

# Changelog

All notable changes are documented here. The format follows Keep a Changelog, versions follow SemVer.

## [0.1.2] — 2026-10-31

### Added

- **AI repair can borrow the harness's own credential**: `$DSH_HOME/.credentials.yaml` `refs:` is read when no key is in the environment (`ai.credentialSource`: `auto`/`env`/`dsh`/`none`, plus `ai.keyRef`), so the second opinion still works while `dsh web` itself is down.
- **Bridge transport** (`ai.bridge`): the prompt goes to a program's stdin and the JSON verdict comes back on stdout — no model endpoint needed from the guard's side.
- **IM discovery**: `GET /api/restart-guard/im` lists `dsh-im` bots and targets; the settings page offers pickers and the doctor cross-checks the configured bot/target.
- **Container log mirroring** (`logs.mirrorToHostLog`, default on): guard lines are echoed into the host's stdout as `[dsh-restart-guard] …`, so repairs show up in `docker logs` while the server is down.

### Fixed

- **Watcher handover could kill itself**: a successor started with `--replace` inherited the previous watcher's `stop` control and exited immediately, so the host respawned it every ten seconds. The successor now clears that handover stop, the version string is read from `package.json`, and `ensureWatcher()` only replaces a watcher whose on-disk version differs (throttled to once per ten minutes).

## [0.1.0] — 2026-10-31

First public release.

### Fixed

- `bin` used `./lib/cli.mjs`; npm rewrites that during publish and warns, so the path is now `lib/cli.mjs`.
- `files` now ships `dsh-restart-guard.bundle.yml`; without it a published install had no bundle patch and `dsh plugin add` could not activate the plugin.

### Added

- **Detached watcher** that outlives the DSH host: a crash, `kill -9` or a failed restart is detected within `probeIntervalMs` and repaired.
- **Health classification** that distinguishes DSH (`401` + auth text, or `200` + `__DSH_BOOT__`) from a foreign listener, a slow host and a dead port. Foreign holders are reported, never killed.
- **Byte-offset readiness**: the boot log is read only from the offset taken before `spawn`, so stale access lines cannot fake readiness or leak a previous launch token. Fallback `ready-without-access-line` for piped stdout.
- **Diagnosis** of boot failures: YAML/patch errors, wildcard host, missing module, port conflict, permission/disk/memory, crashes, plugin load failures, startup timeouts.
- **Bounded repair ladder**: patch rollback validated through `dsh --dump-config`, stale-holder handling (opt-in), at most two starts three seconds apart, crash-loop pause after three incidents in ten minutes.
- **Upgrade/maintenance awareness**: six independent signals (explicit window, tree change, sibling trees, package manager, `$DSH_HOME/upgrade`, slow boot). No spawn, no rollback, no kill while active; an incomplete tree is reported instead of half-started.
- **Intentional stop** respected (`control/exit.json`), plus arbitration when another restarter is already working.
- **Notification channels**: rotating log, webhook presets (generic, Feishu, WeCom, DingTalk, Slack, Telegram, Discord, ntfy, Healthchecks), command with message on stdin, and `dsh-im` with an outbox that the host replays.
- **Settings page**: environment report with actionable hints, notification fields with a test button, watchdog policy, dangerous-actions guard, incident list, auto refresh.
- **CLI**: `status`, `doctor`, `logs`, `incidents`, `outbox`, `restart`, `rollback`, `start`, `simulate-crash`, `pause`, `resume`, `notify-test`, `maintenance`, `reload`, `ai-test`, `install`, `uninstall`, `purge`, `version`.
- **AI-assisted repair** (optional, off by default): a model may answer with one of `retry`, `rollback-patch`, `wait`, `manual`, and the verdict is mapped onto the existing allow-listed actions. It is only consulted when the rule-based ladder would stop at `manual`; it can never override maintenance, incomplete-tree, supervisor or foreign-holder stops, and it cannot introduce commands.
- **Supervision override**: `supervision.mode` (`auto`/`none`/`supervised`) when detection cannot see who owns restarts (CI, containers with a foreign init).
- **Security**: per-boot guard token injected into the app shell, POST-only allow-listed mutations with a 64 KiB body cap, remote mutation refusal, `O_NOFOLLOW` appends, `0700/0600` state, secret redaction, no runtime dependencies.
- **Tests**: 85 tests including end-to-end repairs against a fake `dsh web`, slow-host, crash-loop, maintenance and AI verdict cases.

### Privacy

- No telemetry; with no channel configured, no outbound traffic beyond the loopback probe.
- Environment values are not stored (only names); launch token, cookies and access URLs never leave the machine unless explicitly enabled.
- Retention: 50 incidents, 24 h outbox, 2 × 5 MB logs. `purge` removes everything.
