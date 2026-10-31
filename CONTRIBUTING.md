# Contributing

Thanks for helping. This project is deliberately small and dependency-free.

## Ground rules

- **Zero runtime dependencies.** New runtime deps are rejected by review; use Node built-ins (`node:fs`, `node:http`, `node:child_process`, global `fetch`).
- Node ≥ 22, ESM only. Every source file starts with `// @ts-check` and carries JSDoc for public functions. Do not add a build step for host code.
- The browser bundle is generated: edit `src/client.jsx`, then run `pnpm run build:client` and commit the result. `prepack` fails if the committed bundle is stale, so `pnpm run build:client --check` must pass in CI.
- Anything that mutates the system (spawn, kill, write) needs a test that proves the refusal path too.

## Setup

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
```

Tests use `node:test` and real child processes; no Docker, no network. The end-to-end watcher test takes ~10 s.

## Where to change what

| Change | File |
| --- | --- |
| new diagnosis rule | `lib/shared/diagnose.js` + `test/diagnose.test.mjs` |
| new repair action | `lib/shared/plan.js` (planning) + `lib/watcher.mjs` (execution) + `test/plan.test.mjs` |
| maintenance/upgrade signal | `lib/shared/maintenance.js` |
| probe/port behaviour | `lib/shared/probe.js` |
| notification channel | `lib/shared/notify.js` (delivery) + `src/client.jsx` (settings) |
| AI verdict handling | `lib/shared/ai.js` + `test/ai.test.mjs` |
| settings route | `lib/index.js` + `src/client.jsx` |
| CLI command | `lib/cli.mjs` |

## Safety invariants (do not weaken)

1. The watcher never writes a file the host also writes.
2. Readiness only counts log bytes written after the spawn offset.
3. A port held by a foreign process is never killed.
4. Maintenance, incomplete tree and supervisors are hard stops.
5. Model output is data; it is validated against a closed enum and can only *convert a manual stop* into retry/rollback, never into a command.
6. Secrets never reach logs, notifications, incidents or API responses.

Any change to these needs a rationale in the PR description and tests.

## Adding a webhook preset

Add the payload builder to `WEBHOOK_PRESETS` in `lib/shared/config.js` — one function `(report) => {url, body}` — plus the key to `src/client.jsx`'s preset list, rebuild the client, and add a delivery test.

## Release checklist

1. `pnpm run typecheck && pnpm test && pnpm run build:client --check`
2. Update `CHANGELOG.md` (and the **Privacy** heading if stored/sent data changed)
3. `npm pack --dry-run` — only `lib`, `locale`, `docs`, the listed markdown and `LICENSE`
4. `npm publish` (provenance is on via `publishConfig`)
5. Tag `v<version>`; verify on a scratch profile with `dsh web --port 3098 --patch <insert.yml>` before touching a production instance

## Reporting bugs

Include: `dsh-restart-guard version`, `node -v`, platform, `dsh-restart-guard doctor --json`, the relevant section of `restart-guard.log`, and the incident JSON. Redact tokens and host names.
