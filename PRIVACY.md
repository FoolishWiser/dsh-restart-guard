# Privacy

dsh-restart-guard is built for a machine you control. It has **no telemetry, no analytics and no phone-home**: with every notification channel disabled it makes no outbound connection except the loopback health probe.

## What is stored, and where

Everything lives under `$DSH_HOME/restart-guard/` (directories `0700`, files `0600`):

| File | Content | Why |
| --- | --- | --- |
| `config.json` | your settings | the only thing you edit |
| `instances/<profile>-<port>/pid.json` | host pid, start time, protocol, argv with secrets masked, session id | let the watcher follow the host |
| `…/launch.json` | argv (redacted), filtered environment, cwd, boot-log path | restart exactly the same command |
| `…/state.json`, `watcher.json` | phase, health, probe counters, boot progress | the status page and CLI |
| `…/baseline.json` | package-tree version/inode/mtime | detect an upgrade in progress |
| `…/incidents/*.json` | diagnosis, evidence, plan, hints | post-mortem |
| `…/control/*` | requests, pause, maintenance, exit intent | host → watcher channel |
| `…/restart-guard.log` | operational log, rotated at 5 MB × 2 | debugging |
| `…/ALERT.md` | one human-readable page while an incident is unresolved | a file your other tools can pick up |
| `…/outbox/*` | IM messages that could not be delivered | replay when the host returns |

Environment **values** are never stored: `launch.json` keeps the filtered environment captured from the real host process (it must, to restart it faithfully), but secret-looking variables are dropped and only variable **names** are listed in `state.json`. The launch token, cookies and access URLs are not captured.

## What leaves the machine

Only when you configure a channel:

- **Webhook** — incident title, summary, marks (port, profile, phase), hints and a log tail (default 40 lines). The tail is redacted first. Access URL and launch token are excluded unless you explicitly enable them.
- **Command** — the same message, written to the program's stdin.
- **IM** — the same message through `dsh-im`; bot credentials belong to the IM plugin, not to the guard.
- **AI repair (off by default)** — the redacted boot-log tail (≤ 8 KiB by default) plus the incident facts, sent to the endpoint you configure. No environment values, tokens or host names. The response is not stored beyond the verdict summary in the incident record.

The health probe is a plain `GET http://127.0.0.1:<port>/` and never leaves the loopback interface.

## Retention

- incidents: last 50 (`retention.incidents`)
- outbox: 24 hours (`retention.outboxHours`)
- log: 2 × 5 MB, rotated
- everything else is overwritten in place

`dsh-restart-guard purge` deletes `$DSH_HOME/restart-guard/` entirely; `uninstall` removes the plugin from the profile but keeps the state so you can still read the incidents (use `purge` to remove it).

## Secrets in logs

Notifications and the guard log pass through `redact.js`, which masks launch tokens, `Authorization`/`Cookie` headers, JSON/YAML secret fields, `KEY=value` assignments and common API-key shapes. Redaction is best-effort: if a log line contains a secret in an unusual shape, it may survive. Prefer channels you trust.

## Changes

Any change to what is stored or sent will be listed in [CHANGELOG.md](CHANGELOG.md) under an explicit **Privacy** heading.
