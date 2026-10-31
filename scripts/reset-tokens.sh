#!/usr/bin/env bash
# Resets the process-wide token counter (the MAX_TOTAL_TOKENS cap) without restarting anything.
# Usage: scripts/reset-tokens.sh
curl -s -XPOST "http://localhost:${PORT:-4400}/api/tokens"; echo
