# Security policy

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer listed in `package.json`. Please do not file a public issue for a vulnerability that lets someone restart, stop or reconfigure another user's DSH instance.

Include the version (`dsh-restart-guard version`), the platform, and a minimal reproduction. You can expect an initial response within a week.

## Threat model

The guard is a **local operations tool**. It assumes:

- the operator owns the machine and `$DSH_HOME`;
- other local users of the same account are trusted (they can read the config and the state directory, just as they can read `~/.dsh`);
- the DSH web UI itself is already protected by DSH's own session auth.

It does **not** trust:

- the network. The settings API is exposed through the same web server as the UI, so it must not be callable by an anonymous browser that merely reaches the port.
- content in logs. Log lines, notifications, argv and environment are treated as untrusted text and redacted before storage or delivery.
- the AI provider. A model's answer is data: it is validated against a closed enum and mapped onto existing actions; it is never executed.

## Controls

### Settings API

- Every mutating request must carry `x-restart-guard-token`. The token is generated per host boot and injected into the app shell through `webServer.tapIndex` as `<meta name="dsh-restart-guard-token">`. It is only readable after the DSH page itself has been served, i.e. after DSH's own authentication.
- Mutations are `POST` only, `content-type: application/json`, body ≤ 64 KiB, and the action is checked against a fixed allow-list.
- Requests that arrive with proxy headers (`cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`, `forwarded`) are treated as remote. Remote configuration changes and mutations are rejected unless `security.allowRemoteMutations` is explicitly enabled. Dangerous actions (`simulate-crash`) additionally need `security.dangerousActions`.
- A missing or stale token answers `403 forbidden: missing or stale guard token (reload the page)`. It never falls back to "anything goes on loopback": deployments behind a reverse proxy make every request look local, so loopback is not an authority signal.

### Filesystem

- State lives in `$DSH_HOME/restart-guard/`: directories `0700`, files `0600` (`config.json`, `launch.json`, plans, incidents).
- Appends open with `O_NOFOLLOW`; a symlinked log or config is refused rather than written through.
- Paths derived from user input are sanitized (`sanitizeId`) and confined to the instance directory.
- Patch rollback only writes `<profileDir>/cordis.patch.yml`; it validates a candidate through `dsh --profile <p> --dump-config` before swapping, and preserves the broken file as `cordis.patch.yml.guard-broken-<timestamp>`.
- `install`/`uninstall` back up `package.json` before editing it (`package.json.guard-bak-<timestamp>`).

### Process control

- The watcher starts processes only from a launch spec captured from a real `dsh web` process: argv array, filtered environment (values of secrets dropped), cwd. No shell is involved.
- `killStaleDshHolder` is off by default. When enabled, a pid is only signalled after its cmdline contains both `dsh` and `web`, and only when it owns the guard's port.
- A port held by a non-DSH process is never killed; the incident is reported instead.
- Under a supervisor (systemd/pm2/…) the guard refuses to start a competing server.
- Optional AI repair can never override maintenance, incomplete-tree, supervisor or foreign-holder stops.

### Secrets

- `redact.js` masks `token`, `?token=`, `authorization`, `cookie`, API-key-like fields, JSON/YAML secret fields, `KEY=value` assignments, Slack/GitHub/JWT-shaped strings.
- Webhook URLs and IM identifiers are masked in API responses; the launch token and access URL are never included in notifications unless `notify.includeLaunchToken` / `includeAccessUrl` are enabled.
- API keys are read from the environment at call time and are never persisted; only the variable **name** is stored.

## Known limitations

- Anyone who can read the DSH page HTML in the same origin can read the guard token. That is the same trust boundary as the DSH UI itself.
- The guard is not protected against a malicious local user with the same account; they can edit `config.json` or the watcher source directly.
- HTTP (not HTTPS) probing to `127.0.0.1` is used by default; set a TLS front end and `protocol: https` if your deployment requires it.
- The AI provider receives the redacted log tail. Treat that as data leaving the machine and enable it deliberately.
