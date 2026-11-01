#!/usr/bin/env bash
# Demo: a third-party plugin breaks DSH startup, the guard asks the AI, the AI
# repairs the plugin file, and DSH is started again.
#
#   demo/run.sh            # deterministic, offline (stub AI through ai.bridge)
#   demo/run.sh --real     # real model through the DSH credentials store
#   demo/run.sh --keep     # leave the demo instance running for inspection
#
# The live DSH on port 3079 is never touched: everything happens on PORT
# (default 3098) with its own guard config file.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3098}"
PROFILE="${PROFILE:-web}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
WORK="${DEMO_WORK:-/tmp/guard-demo}"
REAL=0
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --real) REAL=1 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
mkdir -p "$WORK"
rm -f "$WORK/host.log"

PLUGIN="$ROOT/demo/broken-plugin"
CONFIG_FILE="$WORK/config.json"
INSERT="$WORK/insert-broken.yml"
NODE="${NODE:-$(command -v node)}"
DSH_BIN="${DSH_BIN:-$(command -v dsh)}"
GUARD_DIR="$HOME_DIR/restart-guard/instances/$PROFILE-$PORT"

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\n!! %s\n' "$*" >&2; exit 1; }

say "1/6 prepare: broken plugin enabled=false, demo instance on port $PORT"
printf '{\n  "enabled": false\n}\n' > "$PLUGIN/demo-config.json"
mkdir -p "$HOME_DIR/profiles/$PROFILE/node_modules"
ln -sfn "$PLUGIN" "$HOME_DIR/profiles/$PROFILE/node_modules/dsh-demo-broken"
# A plain insert row is optional: a failure there is only a warning. Registering
# the package under a required loader id makes the failure abort startup, which
# is what a third-party plugin that breaks boot looks like to DSH.
cat > "$INSERT" <<EOF
- insert:
    - id: modules
      name: dsh-demo-broken
EOF

node - "$CONFIG_FILE" "$REAL" "$NODE" "$ROOT/demo/stub-ai.mjs" "$WORK" <<'NODE'
const fs = require('node:fs')
const [file, real, node, stub, work] = process.argv.slice(2)
const base = {
  schemaVersion: 1,
  enabled: true,
  locale: 'zh',
  watchdog: {
    probeIntervalMs: 1000,
    probeTimeoutMs: 2000,
    startupGraceMs: 5000,
    bootTimeoutMs: 120000,
    settleMs: 1000,
    stalledExitMs: 15000,
    maxRestartAttempts: 2,
  },
  readiness: { inferredSettleMs: 30000, inferredQuietMs: 8000 },
  supervision: { mode: 'none' },
  maintenance: { autoDetect: false },
  logs: { bootLogPath: `${work}/host.log`, mirrorToHostLog: false },
  security: { dangerousActions: true },
  notify: { webhook: { enabled: false }, command: { enabled: false }, im: { enabled: false } },
  ai: real === '1'
    ? { enabled: true, mode: 'act', order: 'dsh-agent-first', credentialSource: 'dsh' }
    : { enabled: true, mode: 'act', order: 'direct-only', credentialSource: 'none', bridge: { enabled: true, program: node, args: [stub] } },
}
fs.writeFileSync(file, JSON.stringify(base, null, 2) + '\n', { mode: 0o600 })
NODE

export DSH_HOME="$HOME_DIR"
export DSH_RESTART_GUARD_CONFIG="$CONFIG_FILE"

say "2/6 start DSH once with the plugin healthy (this starts the guard watcher)"
printf '{\n  "enabled": true\n}\n' > "$PLUGIN/demo-config.json"
setsid nohup "$DSH_BIN" --profile "$PROFILE" --patch "$INSERT" --port "$PORT" --no-open > "$WORK/host.log" 2>&1 &
HOST_STARTED=$!
# DSH answers 401 before every plugin is activated, so wait for the access line
# as well: the guard plugin writes pid.json only after the host is really up.
for _ in $(seq 1 180); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  if [ "$code" = "401" ] && grep -q 'dsh web: http' "$WORK/host.log" 2>/dev/null; then
    break
  fi
  sleep 1
done
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
[ "$code" = "401" ] || fail "DSH did not become ready on $PORT (last http=$code); see $WORK/host.log"
for _ in $(seq 1 30); do
  [ -f "$GUARD_DIR/pid.json" ] && break
  sleep 1
done
[ -f "$GUARD_DIR/pid.json" ] || fail "the guard watcher did not start on $PORT; see $WORK/host.log"
sleep 1

say "3/6 AI preflight (ai-test through the configured channel)"
(cd "$ROOT" && node lib/cli.mjs ai-test --home "$HOME_DIR" --port "$PORT" --json 2>&1 | tail -5) || true

say "4/6 break the plugin, then kill the host: DSH must fail to boot"
printf '{\n  "enabled": false\n}\n' > "$PLUGIN/demo-config.json"
HOST_PID=$(node -e "try{console.log(require('$GUARD_DIR/pid.json').pid)}catch(e){console.log($HOST_STARTED)}")
kill -9 "$HOST_PID" 2>/dev/null || true
echo "killed host pid $HOST_PID; waiting for the guard to repair the plugin and restart DSH"
for _ in $(seq 1 180); do
  pid_json="$GUARD_DIR/pid.json"
  new_pid=$(node -e "try{console.log(require('$pid_json').pid)}catch(e){console.log(0)}")
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  if [ "$code" = "401" ] && [ "$new_pid" != "$HOST_PID" ] && [ "$new_pid" != "0" ]; then
    break
  fi
  sleep 1
done
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
[ "$code" = "401" ] || fail "the guard did not bring DSH back (last http=$code); see $GUARD_DIR/restart-guard.log"

say "5/6 result"
node -e "
const fs=require('fs');
const cfg=JSON.parse(fs.readFileSync('$PLUGIN/demo-config.json','utf8'));
const state=JSON.parse(fs.readFileSync('$GUARD_DIR/state.json','utf8'));
console.log('demo-config.json enabled =', cfg.enabled);
console.log('phase =', state.phase, '| restarts =', (state.restarts||[]).length);
console.log('ai =', JSON.stringify(state.ai && {via:state.ai.via, ok:state.ai.ok, action:state.ai.verdict && state.ai.verdict.action}));
console.log('repair =', JSON.stringify(state.repair && {kind:state.repair.kind, entryName:state.repair.entryName, changed:(state.repair.changed||[]).map(c=>c.file)}));
console.log('last plan =', JSON.stringify((state.plan&&state.plan.steps||[]).map(s=>s.action+':'+s.status)));
"
grep -E 'ai-[a-z]+|verified|incident-resolved|spawn ' "$GUARD_DIR/restart-guard.log" | tail -8 || true
say "6/6 done: DSH is back on http://127.0.0.1:$PORT"

if [ "$KEEP" = "1" ]; then
  echo "leaving the demo instance running (--keep): clean up with demo/stop.sh"
else
  "$ROOT/demo/stop.sh" || true
fi
