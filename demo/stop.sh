#!/usr/bin/env bash
# Stop the demo instance and remove its temporary wiring (the live DSH and the
# live profile are not touched).
set -u
PORT="${PORT:-3098}"
PROFILE="${PROFILE:-web}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
GUARD_DIR="$HOME_DIR/restart-guard/instances/$PROFILE-$PORT"
node -e "
const fs=require('fs');
const dir='$GUARD_DIR';
for (const name of ['pid.json','watcher.json']) {
  try {
    const data=JSON.parse(fs.readFileSync(dir+'/'+name,'utf8'));
    if (data.pid) { try { process.kill(data.pid,'SIGTERM'); console.log('stopped', name, data.pid) } catch {} }
  } catch {}
}
"
sleep 1
pkill -f "lib/watcher.mjs .*--port $PORT" 2>/dev/null || true
rm -f "$HOME_DIR/profiles/$PROFILE/node_modules/dsh-demo-broken"
rm -rf "$GUARD_DIR"
echo "demo instance stopped"
