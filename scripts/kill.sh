#!/usr/bin/env bash
# Inverse of scripts/dev.sh. Stops whatever is listening on the local demo ports,
# plus the dev wrapper if it is still running.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORTS=(3000 8001 8080 5173 80)

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    echo ":$port clear"
    return
  fi
  echo "Stopping :$port ($pids)"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || sudo -n kill $pids 2>/dev/null || true
  sleep 0.4
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || sudo -n kill -9 $pids 2>/dev/null || true
    echo "Force-stopped :$port ($pids)"
  fi
}

if pgrep -f "$ROOT/scripts/dev.sh" >/dev/null 2>&1; then
  echo "Stopping pnpm dev"
  pkill -f "$ROOT/scripts/dev.sh" 2>/dev/null || true
  sleep 0.5
fi

for port in "${PORTS[@]}"; do
  stop_port "$port"
done

# Parents that do not hold the listen socket themselves.
pkill -f "$ROOT/services/agent.*proxiprompt_agent.agent" 2>/dev/null || true
pkill -f "proxiprompt_agent.agent" 2>/dev/null || true

echo "Local demo ports stopped (3000 SpacetimeDB, 8001 agent, 8080 orchestrator, 5173 web)."
