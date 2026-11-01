# Troubleshooting

Start with:

```bash
dsh-restart-guard status --json
dsh-restart-guard doctor
tail -n 80 "$DSH_HOME/restart-guard/instances/"*/restart-guard.log
```

The settings page shows the same doctor report. `ALERT.md` in the instance directory exists only while an incident is unresolved.

## The guard does nothing

| Check | Meaning | Fix |
| --- | --- | --- |
| `status` says "no guard instance" | the host plugin has not booted yet, or `pid.json` is missing | restart DSH; check that `dsh-restart-guard` is in `dsh.profile.bundles` |
| `phase: paused` | crash loop or manual pause | `dsh-restart-guard resume` |
| `phase: maintenance` | an upgrade or maintenance window was detected | wait, or `dsh-restart-guard maintenance end` |
| `phase: stopped` | the previous host exited cleanly (intentional stop) | start DSH yourself, or set `watchdog.respectIntentionalStop: false` |
| `phase: manual` | the guard stopped on purpose; read `ALERT.md` | fix the reported cause, then `resume` |
| doctor shows supervisor `systemd`/`pm2` | someone else owns restarts | let the supervisor do it; the guard only reports |

## `manual` with `startup failed` or `plugin failed to load`

The boot log tail names the row that failed. Typical fixes:

- disable the offending row in `cordis.patch.yml` (the guard keeps a broken copy as `cordis.patch.yml.guard-broken-*` after a failed rollback);
- if it is a missing import, reinstall the plugin in the profile (`pnpm install` in `$DSH_HOME/profiles/<profile>`);
- fix YAML indentation; validate with `dsh --profile <profile> --dump-config`.

## `wildcard-host`

DSH ≥ 0.2.1 refuses `0.0.0.0` / `::` as `--host`. Use a concrete address (`127.0.0.1`, a LAN IP) or a reverse proxy.

## `port-in-use` and the occupant is not DSH

The guard never kills another program. Find the holder (`dsh-restart-guard doctor`, `ss -ltnp`, or `lsof -i :<port>`), stop it, then `dsh-restart-guard resume`.

If the occupant *is* a stale `dsh web`, set `watchdog.killStaleDshHolder: true` and restart the guard; it will only signal a pid whose cmdline contains both `dsh` and `web`.

## "it repaired, but I keep getting notifications"

- the service is crash-looping: after 3 incidents in 10 minutes the guard pauses for 30 minutes and tells you once. Read `ALERT.md`.
- notifications repeat because `notify.throttleMs` is small for your taste; the default is 60 s per incident severity.
- the guard sees a *foreign* listener and retries nothing, but reports every probe failure; check for a second app on the port.

## The restored page asks for a new token

Restarting DSH mints a new launch token, so a **new device** needs the URL printed in the boot log. An already-authenticated browser keeps working (DSH stores a persistent cookie secret). If you need the URL in notifications, enable `notify.includeLaunchToken` / `includeAccessUrl` deliberately.

## Webhook does not arrive

1. `dsh-restart-guard notify-test` — see the error in the output;
2. check the preset: feishu/wecom/dingtalk/slack/telegram/discord/ntfy have different payload shapes;
3. a URL in `DSH_RESTART_GUARD_WEBHOOK_URL` overrides the config; an empty value means "use config";
4. healthchecks-style URLs receive `/fail` when a repair fails and the plain URL when it recovers.

## IM message queued forever

The outbox (`$DSH_HOME/restart-guard/instances/<id>/outbox/`) is replayed by the host every 60 s. If messages stay queued, the host is down or `dsh-im` refused them — open the IM plugin settings and confirm the bot/target ids, then `dsh-restart-guard notify-test`.

## AI test fails

- `no API key: set $KEY` — export the variable named in the AI section (default `DEEPSEEK_API_KEY`), then restart DSH so the watcher inherits it;
- `HTTP 401` — wrong key; `HTTP 404` — wrong endpoint (use the full `/chat/completions` URL);
- `reply is not a JSON object` — the model ignored the instructions; try a more capable model.

AI is consulted **only** when the rule-based plan would stop at `manual`; a broken AI never prevents normal restarts.

## Everything looks healthy but the guard thinks the server is down

Check `health.error` in `state.json`:

- `slow` — the port accepts connections but HTTP answers slowly; the guard deliberately does not restart it. Raise `watchdog.probeTimeoutMs` if your host is slow;
- `foreign` — the response is not DSH (for example a maintenance page). Fix or stop that server;
- `ECONNREFUSED` — nothing is listening; the guard will repair after the grace.

## Resetting

```bash
dsh-restart-guard pause --minutes 30     # stop acting for a while
dsh-restart-guard reload                 # re-read config.json
dsh-restart-guard purge                  # remove all state (plugin stays installed)
```

## The settings page says the drill failed (or nothing restarted)

If `ALERT.md` says `refusing to kill pid ...: [defunct]` or `could not stop the
stale holder`, the killed host was left as a **zombie**: its parent (PID 1 in
many containers) never reaped it, so `kill -0` still succeeds while the process
serves nothing. 0.1.5 and later treat that as gone and start a replacement.
On older versions, restart the container and run the guard with an init:

```yaml
# docker compose
services:
  dsh:
    init: true
```

```bash
docker run --init ...
```

## Two watchers, duplicated log lines

Up to 0.1.4 a hand-over could leave the predecessor running next to the
successor. 0.1.5 addresses stop controls to one pid, leaves the predecessor's
stop alone, and makes every watcher verify that it still owns `watcher.lock`
(`lock-lost` in the log). If you see two `watcher.mjs` processes on an older
version:

```bash
pkill -f 'lib/watcher.mjs --home'   # the host respawns exactly one
```

## DSH answers 401 but the page is broken

`dsh web` prints `dsh: startup failed: N required plugin(s) did not activate`
and keeps the process alive, so a plain port probe would call it healthy. Since
0.1.7 the guard reads the new boot-log bytes and treats that block as a failed
boot, kills the half-started process and repairs. If it still reports healthy,
check `state.diagnostics.mirror`/`mirrorPath`: the guard must be reading the
boot log this host actually writes.

## The AI repair was rejected

- `edit path "…" must stay inside the plugin directory` — the model tried a
  path outside the failing package; nothing was written.
- `demo-config.json does not exist inside the plugin` — the verdict targeted a
  file that is not part of the package (only existing files may be edited).
- `… is a core package and is never edited by AI` — `@deepseek-ai/*` and the
  guard itself are protected; use `disable-plugin` or a manual fix instead.
- `syntax check failed for …` — the file was rolled back; every edited file is
  restored from its `.guard-bak-<ts>` backup.
- Use **Undo AI repair** (or `restore-repair`) to revert a successful fix.

## Reproduce the plugin-repair demo

`demo/run.sh` (offline stub) or `demo/run.sh --real` runs the whole scenario on
an isolated port; `--keep` leaves it running for inspection, `demo/stop.sh`
cleans it up.
