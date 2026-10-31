#!/usr/bin/env bash
# Clears tickets + event log in the Company actor, deletes ticket working copies and factory/* branches in demo-repo.
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/../brain" && exec bun scripts/reset.ts
