#!/usr/bin/env bash
# Browser end-to-end of SPEC §14 against proxiprompt-test.
# Starts a second orchestrator (:8081) and a second Vite (:5174). Reuses SpacetimeDB
# on :3000 and the agent on :8001. Never publishes or writes the live proxiprompt database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.local/bin:${PATH}"

export WEB_PORT=5174
export ORCH_PORT=8081
export SPACETIMEDB_DB=proxiprompt-test
unset SPACETIMEDB_TOKEN || true
export SPACETIMEDB_URI="${SPACETIMEDB_URI:-ws://127.0.0.1:3000}"
export DEMO_MODE=1
export ENABLE_BLUESKY=0
export ENABLE_DEV_WIPE=1
export AGENT_URL="${AGENT_URL:-http://127.0.0.1:8001}"
export ORCH_PROXY_TARGET="http://127.0.0.1:${ORCH_PORT}"
export VITE_SPACETIMEDB_DB=proxiprompt-test
export VITE_SPACETIMEDB_URI="${SPACETIMEDB_URI}"
export VITE_ORCH_URL="http://127.0.0.1:${ORCH_PORT}"
export E2E_WEB_URL="http://127.0.0.1:${WEB_PORT}"

if [[ "$SPACETIMEDB_DB" == "proxiprompt" ]]; then
  echo "Refusing to run browser e2e against the live proxiprompt database."
  exit 1
fi

listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# Any HTTP response counts. /v1/identity answers 405 to GET, which still means the server is up.
up() {
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" "$1" || true)"
  [[ "$code" != "000" && -n "$code" ]]
}

pids=()
# pnpm/tsx outlive the subshell we recorded, and the next run refuses a busy port.
cleanup() {
  local pid listeners port
  for pid in ${pids[@]+"${pids[@]}"}; do
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  done
  for port in "$ORCH_PORT" "$WEB_PORT"; do
    listeners="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$listeners" ]]; then
      kill $listeners 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  sleep 0.3
}
trap cleanup EXIT INT TERM

if listening "$ORCH_PORT"; then
  echo "Port ${ORCH_PORT} is already in use. Stop that process before browser e2e."
  exit 1
fi
if listening "$WEB_PORT"; then
  echo "Port ${WEB_PORT} is already in use. Stop that process before browser e2e."
  exit 1
fi
if ! up "http://127.0.0.1:3000/v1/identity"; then
  echo "SpacetimeDB is not running on :3000. Start it with: spacetime start --listen-addr 127.0.0.1:3000"
  exit 1
fi
if ! up "http://127.0.0.1:8001/health"; then
  echo "Agent is not running on :8001. Start the dev stack, or the agent, and retry."
  exit 1
fi

echo "Clearing proxiprompt-test"
(cd "$ROOT/spacetimedb" && spacetime publish --server local --module-path . proxiprompt-test --delete-data=always -y)

echo "Starting test orchestrator on :${ORCH_PORT}"
(cd "$ROOT/services/orchestrator" && pnpm exec tsx src/index.ts) > /tmp/proxiprompt-e2e-orch.log 2>&1 &
pids+=($!)

echo "Starting test web app on :${WEB_PORT}"
(cd "$ROOT/apps/web" && pnpm exec vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort) > /tmp/proxiprompt-e2e-web.log 2>&1 &
pids+=($!)

ready=0
for _ in $(seq 1 80); do
  health="$(curl -sf "http://127.0.0.1:${ORCH_PORT}/health" || true)"
  if [[ "$health" == *'"connected":true'* ]] && up "http://127.0.0.1:${WEB_PORT}/"; then
    ready=1
    break
  fi
  sleep 0.25
done
if [[ "$ready" != "1" ]]; then
  echo "Test stack did not become ready."
  echo "--- orchestrator ---"
  tail -n 40 /tmp/proxiprompt-e2e-orch.log || true
  echo "--- web ---"
  tail -n 40 /tmp/proxiprompt-e2e-web.log || true
  exit 1
fi

# Vite inlines VITE_SPACETIMEDB_DB into the transformed module. Refuse to click
# through onboarding if that string is the live database.
module_js="$(curl -sf "http://127.0.0.1:${WEB_PORT}/src/spacetime.tsx")"
if ! grep -q "proxiprompt-test" <<<"$module_js"; then
  echo "Refusing to run: the test web app is not pointed at proxiprompt-test."
  exit 1
fi

echo "Wiping leftover activity on the test database"
curl -sf -X POST "http://127.0.0.1:${ORCH_PORT}/dev/wipe" -H "X-ProxiPrompt-Dev: 1" >/dev/null

echo "Running Playwright"
pnpm exec playwright test "$@"
