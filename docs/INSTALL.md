# Install, upgrade, remove

## 1. Install the package

From a checkout:

```bash
cd /path/to/dsh-restart-guard
pnpm install --ignore-scripts     # dev deps only; nothing runs at runtime
```

From npm, after release:

```bash
dsh plugin --profile web add dsh-restart-guard
```

`add` forwards to `pnpm` inside `~/.dsh/profiles/web`. It edits `dependencies` only; the profile still needs the bundle listed.

## 2. Register the bundle

Either use the bundled installer (edits `package.json`, backs it up, then runs `pnpm install`):

```bash
npx dsh-restart-guard install --profile web --dry-run   # see what would change
npx dsh-restart-guard install --profile web
```

or do it by hand in `$DSH_HOME/profiles/web/package.json`:

```jsonc
{
  "dependencies": {
    "dsh-restart-guard": "link:/path/to/dsh-restart-guard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …existing bundles…
        "dsh-restart-guard"
      ]
    }
  }
}
```

then `pnpm install` in that directory. The package ships its own bundle patch (`dsh-restart-guard.bundle.yml`), which inserts the loader row; you do **not** need to edit `cordis.patch.yml`.

## 3. Restart DSH

```bash
# your usual restart path, e.g.
dsh web --port 3079
```

Within 10 seconds of boot the plugin writes `pid.json` and spawns the watcher. Confirm:

```bash
dsh-restart-guard status
dsh-restart-guard doctor
```

`status` should show a live watcher and `phase: monitoring`; `doctor` lists environment gaps.

## 4. Configure

Open **Settings → Restart guard**:

1. read the **report** at the top; fix highlighted items;
2. **Notifications**: paste a webhook URL (choose the preset matching your service) or the `dsh-im` `botId`/`targetId`;
3. **Test notification** — you should receive a message;
4. optional: **Simulate crash** (requires `security.dangerousActions`) to rehearse a full repair;
5. optional: **AI-assisted repair** (off by default).

Alternative: edit `$DSH_HOME/restart-guard/config.json` directly (mode 0600); the watcher reloads it.

## Requirements

- Node ≥ 22, DSH ≥ 0.2.1.
- Linux for full `/proc` support (process/port mapping, stdout capture). macOS: probing, planning, notifications and supervision detection work; port holders fall back to `lsof`.
- Network access is not required; nothing is downloaded at runtime.

## Upgrading DSH

Run your normal upgrade. The guard recognises the swap (tree change, sibling trees, `$DSH_HOME/upgrade`, package manager, restarter process) and stands down. If the upgrade fails and leaves the tree incomplete, the guard reports it and refuses to start a competing server.

After an upgrade that changes the plugin API, reinstall this plugin in the profile (`pnpm install`) so its peer expectations are re-resolved.

## Upgrading the guard

```bash
cd /path/to/dsh-restart-guard && git pull
pnpm install --ignore-scripts
dsh-restart-guard install --profile web   # idempotent
# restart DSH; the old watcher is replaced (--replace) once the new host boots
```

## Remove

```bash
dsh-restart-guard uninstall --profile web   # removes dependency + bundle, keeps state
dsh-restart-guard purge                     # deletes $DSH_HOME/restart-guard
```

`uninstall` runs `pnpm install` afterwards and prints the restart hint. State is kept deliberately so you can read incidents after removing the plugin; `purge` removes it.

## Containers

- Mount/persist `$DSH_HOME` (or at least `$DSH_HOME/restart-guard`) so state survives a container restart.
- The entrypoint must not `exec` away a parent that would reap the watcher; the watcher is detached and ignores SIGHUP, but a PID-1 that kills the whole process group will take it down. In that case, run the guard from the supervisor instead (see below).
- If the container platform restarts DSH itself, the guard detects the returning port and waits.
- If detection cannot tell who owns restarts, set `supervision.mode` explicitly: `"none"` makes the guard act (nobody else will restart DSH), `"supervised"` makes it report only.

## Under systemd / pm2 / supervisord

The guard detects the supervisor and only reports; it will not start a competing server. If you want it to own restarts, run DSH *without* a supervisor (or disable the supervisor's restart) and let the guard do the work. `supervisor.mayAct` is `true` for plain containers without init, because nobody else would restart DSH there.
