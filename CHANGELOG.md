# Changelog

All notable changes are documented here. The format follows Keep a Changelog, versions follow SemVer.

## [0.1.0] — 2026-10-31

First public release.

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
- **Security**: per-boot guard token injected into the app shell, POST-only allow-listed mutations with a 64 KiB body cap, remote mutation refusal, `O_NOFOLLOW` appends, `0700/0600` state, secret redaction, no runtime dependencies.
- **Tests**: 85 tests including end-to-end repairs against a fake `dsh web`, slow-host, crash-loop, maintenance and AI verdict cases.

### Privacy

- No telemetry; with no channel configured, no outbound traffic beyond the loopback probe.
- Environment values are not stored (only names); launch token, cookies and access URLs never leave the machine unless explicitly enabled.
- Retention: 50 incidents, 24 h outbox, 2 × 5 MB logs. `purge` removes everything.
