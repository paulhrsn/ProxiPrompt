#!/usr/bin/env bash
# One command for local demo. Starts SpacetimeDB, the Fetch agent, the orchestrator,
# and the web app. Asker and responder are two browser tabs, not two servers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.local/bin:${PATH}"
# Service secrets (ASI_ONE_API_KEY, VAPID keys) live in git-ignored .env files; nothing else
# loads them, so export them here before the defaults below.
for envfile in "$ROOT/services/agent/.env" "$ROOT/services/orchestrator/.env"; do
  if [[ -f "$envfile" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$envfile"
    set +a
  fi
done
export DEMO_MODE="${DEMO_MODE:-1}"
# Lets the web app's "Wipe activity (dev)" button reach the orchestrator. Local dev only.
export ENABLE_DEV_WIPE="${ENABLE_DEV_WIPE:-1}"
export AGENT_URL="${AGENT_URL:-http://127.0.0.1:8001}"
export AGENT_PORT="${AGENT_PORT:-8001}"
# STDB_TARGET=maincloud runs against the hosted database instead of a local SpacetimeDB.
STDB_TARGET="${STDB_TARGET:-local}"
if [[ "$STDB_TARGET" == "maincloud" ]]; then
  export SPACETIMEDB_URI="${SPACETIMEDB_URI:-wss://maincloud.spacetimedb.com}"
  export SPACETIMEDB_DB="${SPACETIMEDB_DB:-proxiprompt-mhacks}"
  export VITE_SPACETIMEDB_URI="$SPACETIMEDB_URI"
  export VITE_SPACETIMEDB_DB="$SPACETIMEDB_DB"
fi
export SPACETIMEDB_URI="${SPACETIMEDB_URI:-ws://127.0.0.1:3000}"
export SPACETIMEDB_DB="${SPACETIMEDB_DB:-proxiprompt}"
export ORCH_PORT="${ORCH_PORT:-8080}"
# The agent's Chat Protocol needs this to reach the live network. Without it the ASI:One
# path silently answers with a plan instead of real evidence (services/agent bridge.py).
export ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://127.0.0.1:${ORCH_PORT:-8080}}"

pids=()
started_spacetime=0
# The :80 forwarder only matters for ngrok / phones. Set SKIP_PORT80=1 to skip the sudo prompt.
SKIP_PORT80="${SKIP_PORT80:-0}"

up() {
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" "$1" || true)"
  [[ "$code" != "000" && -n "$code" ]]
}

cleanup() {
  echo
  echo "Stopping local demo…"
  # `${pids[@]}` on an empty array is an unbound-variable error under `set -u`, which turned
  # any early exit into a confusing second failure.
  for pid in ${pids[@]+"${pids[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ "$started_spacetime" == "1" ]]; then
    pkill -f "spacetimedb-standalone" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ "$SKIP_PORT80" != "1" ]] && ! up "http://127.0.0.1:80/"; then
  if sudo -n true 2>/dev/null; then
    : # sudo already authenticated
  elif [[ -t 0 ]]; then
    echo "macOS needs your password once so ngrok http 80 can reach the app."
    sudo -v || SKIP_PORT80=1
  else
    echo "No terminal for a sudo prompt, skipping the :80 forwarder. The :5173 URLs still work."
    SKIP_PORT80=1
  fi
fi

if [[ "$STDB_TARGET" == "maincloud" ]]; then
  echo "Using MainCloud database ${SPACETIMEDB_DB} (no local SpacetimeDB)"
  echo "Publishing module ${SPACETIMEDB_DB} to MainCloud"
  (cd "$ROOT/spacetimedb" && spacetime publish --server maincloud --module-path . "$SPACETIMEDB_DB" -y)
elif ! up "http://127.0.0.1:3000/v1/identity"; then
  echo "Starting SpacetimeDB on :3000"
  spacetime start --listen-addr 127.0.0.1:3000 > /tmp/proxiprompt-spacetime.log 2>&1 &
  started_spacetime=1
  for _ in $(seq 1 40); do
    up "http://127.0.0.1:3000/v1/identity" && break
    sleep 0.25
  done
  up "http://127.0.0.1:3000/v1/identity" || { echo "SpacetimeDB did not start. See /tmp/proxiprompt-spacetime.log"; exit 1; }
else
  echo "SpacetimeDB already running on :3000"
fi

if [[ "$STDB_TARGET" != "maincloud" ]]; then
  echo "Publishing module ${SPACETIMEDB_DB}"
  (cd "$ROOT/spacetimedb" && spacetime publish --server local --module-path . "$SPACETIMEDB_DB" -y)
fi

echo "Provisioning the worker through the publishing owner"
STDB_URI="$SPACETIMEDB_URI" STDB_DB="$SPACETIMEDB_DB" STDB_SERVER="$STDB_TARGET" pnpm --filter @proxiprompt/spacetimedb exec tsx scripts/bootstrap-worker.ts

echo "Starting Fetch agent on :${AGENT_PORT}"
(cd "$ROOT/services/agent" && uv run python -m proxiprompt_agent.agent) &
pids+=($!)

echo "Starting orchestrator on :${ORCH_PORT}"
(cd "$ROOT/services/orchestrator" && pnpm exec tsx src/index.ts) &
pids+=($!)

echo "Starting web app on :5173"
(cd "$ROOT/apps/web" && pnpm exec vite --host 127.0.0.1 --port 5173) &
pids+=($!)

for _ in $(seq 1 40); do
  up "http://127.0.0.1:5173/" && up "http://127.0.0.1:8001/health" && break
  sleep 0.25
done

if [[ "$SKIP_PORT80" != "1" ]] && ! up "http://127.0.0.1:80/"; then
  sudo node "$ROOT/scripts/forward80.mjs" &
  pids+=($!)
fi

cat <<'EOF'

ProxiPrompt is up. For two separate demo sessions, open both of these:

  Asker      http://localhost:5173/
  Responder  http://127.0.0.1:5173/

On the responder tab: create a different username, open You, and set Demo location
to the same place the asker picks. The question pops up over whatever screen
they are on.

For two real email accounts, use separate browser profiles. The email provider can
share its login across localhost and 127.0.0.1 even though demo sessions are separate.

Ctrl+C stops the agent, orchestrator, web app, and the SpacetimeDB this script started.

EOF

wait
