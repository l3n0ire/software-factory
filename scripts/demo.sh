#!/usr/bin/env bash
# Headless demo: files the demo ticket against a running brain (scripts/start.sh) and prints the event log until done/failed.
# Extra args pass through, e.g. scripts/demo.sh --title "Add GET /pumpkins/spooky" --description "..."
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/../brain" && exec bun src/demo.ts "$@"
