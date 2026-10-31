#!/usr/bin/env bash
# Starts everything: local Relaycast engine (Agent Relay), Terse actor dev server, and the brain + office UI.
# Usage: scripts/start.sh            (Ctrl+C stops everything it started)
#        OPENAI_API_KEY=sk-... scripts/start.sh   for real agents (otherwise a scripted mock LLM is used)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.state"
mkdir -p "$STATE"
export PATH="$HOME/.bun/bin:$PATH"

# Load OPENAI_API_KEY (and any other vars) from .env at the project root, if present.
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi

command -v bun >/dev/null || { echo "Bun >= 1.4.2 is required: curl -fsSL https://bun.sh/install | bash"; exit 1; }
command -v terse >/dev/null || { echo "Terse CLI is required: bunx terse-cli@latest install"; exit 1; }

# The Relaycast engine uses better-sqlite3, which does not build on Node 26; use Node 22 via mise if available.
NODE_RUN=(node)
if command -v mise >/dev/null && mise where node@22 >/dev/null 2>&1; then NODE_RUN=(mise exec node@22 -- node); fi

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

up() { curl -s -o /dev/null --max-time 1 "$1"; }

# 1. Agent Relay (self-hosted Relaycast engine on :8787)
if ! up http://localhost:8787/health && ! up http://localhost:8787/; then
  if [ ! -d "$ROOT/relay/node_modules/@relaycast/engine" ]; then
    if command -v mise >/dev/null; then (cd "$ROOT/relay" && mise exec node@22 -- npm install --silent); else (cd "$ROOT/relay" && npm install --silent); fi
  fi
  echo "starting Relaycast engine on :8787 (log: .state/relay.log)"
  (cd "$ROOT/relay" && "${NODE_RUN[@]}" node_modules/@relaycast/engine/dist/bin/serve.js --db ./relaycast.db --port 8787 >"$STATE/relay.log" 2>&1) &
  PIDS+=($!)
  for _ in $(seq 1 30); do up http://localhost:8787/ && break; sleep 0.5; done
fi
if [ ! -f "$STATE/relay-workspace.json" ]; then
  echo "creating Relay workspace"
  curl -s -XPOST http://localhost:8787/v1/workspaces -H 'content-type: application/json' -d '{"name":"software-factory"}' >"$STATE/relay-workspace.json"
  rm -f "$STATE/relay-agents.json" # agent tokens belong to the old workspace
fi
export RELAY_WORKSPACE_KEY="$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$STATE/relay-workspace.json','utf8')).data.api_key)")"
export RELAY_BASE_URL="http://localhost:8787"

# 2. Terse actors (local dev runtime on :7100, state in actor/.durable-actors)
if ! up http://127.0.0.1:7100/v1/projects/local/deployment/contract; then
  [ -d "$ROOT/actor/node_modules" ] || (cd "$ROOT/actor" && bun install)
  echo "starting Terse actor dev server on :7100 (log: .state/actor.log)"
  (cd "$ROOT/actor" && terse actor dev >"$STATE/actor.log" 2>&1) &
  PIDS+=($!)
  for _ in $(seq 1 60); do up http://127.0.0.1:7100/v1/projects/local/deployment/contract && break; sleep 0.5; done
fi

# 3. Brain + office UI
[ -d "$ROOT/brain/node_modules" ] || (cd "$ROOT/brain" && bun install)
(cd "$ROOT/brain" && terse actor generate --language typescript --non-interactive >/dev/null)
echo "starting brain (Ctrl+C to stop everything)"
cd "$ROOT/brain" && bun src/main.ts 2>&1 | tee -a "$STATE/brain.log"
