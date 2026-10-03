#!/usr/bin/env bash
# One command for local demo. Starts SpacetimeDB, the Fetch agent, the orchestrator,
# and the web app. Asker and responder are two browser tabs, not two servers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.local/bin:${PATH}"
export DEMO_MODE="${DEMO_MODE:-1}"
export ENABLE_BLUESKY="${ENABLE_BLUESKY:-0}"
export AGENT_URL="${AGENT_URL:-http://127.0.0.1:8001}"
export AGENT_PORT="${AGENT_PORT:-8001}"
export SPACETIMEDB_URI="${SPACETIMEDB_URI:-ws://127.0.0.1:3000}"
export SPACETIMEDB_DB="${SPACETIMEDB_DB:-proxiprompt}"
export ORCH_PORT="${ORCH_PORT:-8080}"

pids=()
started_spacetime=0

up() {
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" "$1" || true)"
  [[ "$code" != "000" && -n "$code" ]]
}

cleanup() {
  echo
  echo "Stopping local demo…"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ "$started_spacetime" == "1" ]]; then
    pkill -f "spacetimedb-standalone" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! up "http://127.0.0.1:3000/v1/identity"; then
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

echo "Publishing module proxiprompt"
(cd "$ROOT/spacetimedb" && spacetime publish --server local --module-path . proxiprompt -y)

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

cat <<'EOF'

ProxiPrompt is up. One app, two people — open both of these (they do not share a login):

  Asker      http://localhost:5173/
  Responder  http://127.0.0.1:5173/

On the responder tab: create a different username, open You, and set Demo location
to the same place the asker picks. The question pops up over whatever screen
they are on.

Ctrl+C stops the agent, orchestrator, web app, and the SpacetimeDB this script started.

EOF

wait
