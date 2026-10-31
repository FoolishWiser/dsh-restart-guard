---
name: Bug report
about: Something did not behave as documented
labels: bug
---

**What happened**

**What you expected**

**Environment**
- `dsh-restart-guard version`:
- `node -v`:
- DSH version (`dsh --version`):
- OS / platform:
- how DSH is started (shell, systemd, pm2, container):

**Report**
```
$ dsh-restart-guard doctor --json
$ dsh-restart-guard status --json
```

**Log**
Relevant lines from `$DSH_HOME/restart-guard/instances/<id>/restart-guard.log` and the incident JSON (redact tokens, host names and URLs).
