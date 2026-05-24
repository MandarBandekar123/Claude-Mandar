#!/usr/bin/env bash
# poll.sh — run once, leave it running, never touch it again.
# Watches for pending backtest requests pushed by cloud Claude,
# runs them via trader-dev API, pushes results back to git.
#
# Usage:
#   cd ~/claude-mandar
#   TRADER_DEV_API_KEY=pk_byFvHR3_86OtLt3mVmslkXV8J1w7uZMH bash runner/poll.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REQUESTS_DIR="$REPO_DIR/backtest-requests"
RUNNER_SCRIPT="$REPO_DIR/runner/run-backtest.js"
BRANCH="claude/add-trader-dev-mcp-dJbZq"
POLL_INTERVAL=20   # seconds between git pulls

if [ -z "${TRADER_DEV_API_KEY:-}" ]; then
  echo "ERROR: TRADER_DEV_API_KEY is not set."
  echo "Run: TRADER_DEV_API_KEY=pk_byFvHR3_86OtLt3mVmslkXV8J1w7uZMH bash runner/poll.sh"
  exit 1
fi

export TRADER_DEV_API_KEY

echo "========================================"
echo " Backtest Poller — watching $BRANCH"
echo " Repo: $REPO_DIR"
echo " Interval: ${POLL_INTERVAL}s"
echo "========================================"

git -C "$REPO_DIR" config user.email "runner@claude-mandar" 2>/dev/null || true
git -C "$REPO_DIR" config user.name "Backtest Runner"         2>/dev/null || true

while true; do
  # Pull latest
  git -C "$REPO_DIR" pull --quiet origin "$BRANCH" 2>/dev/null || true

  # Find pending requests
  PENDING=$(find "$REQUESTS_DIR" -name "*.json" -exec grep -l '"status":"pending"' {} \; 2>/dev/null || true)

  if [ -n "$PENDING" ]; then
    for req in $PENDING; do
      echo ""
      echo "$(date '+%H:%M:%S') — Found request: $(basename $req)"
      node "$RUNNER_SCRIPT" "$req" || echo "  !! Error processing $req"
    done

    # Push results back
    git -C "$REPO_DIR" add backtest-requests/ backtest_results/ 2>/dev/null || true
    if ! git -C "$REPO_DIR" diff --staged --quiet; then
      git -C "$REPO_DIR" commit -m "Backtest results: $(date '+%Y-%m-%d %H:%M')"
      git -C "$REPO_DIR" push origin "$BRANCH"
      echo "$(date '+%H:%M:%S') — Results pushed to git."
    fi
  else
    printf "."   # heartbeat dot so you can see it's alive
  fi

  sleep "$POLL_INTERVAL"
done
