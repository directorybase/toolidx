#!/usr/bin/env bash
# Overnight QC pipeline launcher for Robodorm
# Runs discover.py and qc-runner.py in parallel, logs to logs/
#
# Usage:
#   GITHUB_TOKEN=ghp_... TOOLIDX_API_KEY=... bash scripts/run-overnight.sh
#
# Logs:
#   logs/discover.log
#   logs/qc-runner.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$REPO_DIR/logs"

mkdir -p "$LOG_DIR"

if [[ -z "${TOOLIDX_API_KEY:-}" ]]; then
    echo "Error: TOOLIDX_API_KEY not set" >&2
    exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "WARNING: GITHUB_TOKEN not set — GitHub rate limit will make discovery very slow"
fi

echo "[overnight] Starting pipeline — $(date)"
echo "[overnight] Logs: $LOG_DIR"
echo ""

# Start discovery in background (-u = unbuffered stdout)
python3 -u "$SCRIPT_DIR/discover.py" \
    2>&1 | tee "$LOG_DIR/discover.log" &
DISCOVER_PID=$!
echo "[overnight] discover.py started (PID $DISCOVER_PID)"

# Give discovery a 30s head start before QC begins
sleep 30

# Start QC runner in background
python3 -u "$SCRIPT_DIR/qc-runner.py" --workers 5 \
    2>&1 | tee "$LOG_DIR/qc-runner.log" &
QC_PID=$!
echo "[overnight] qc-runner.py started (PID $QC_PID)"

echo ""
echo "[overnight] Both processes running. Monitor with:"
echo "  tail -f $LOG_DIR/discover.log"
echo "  tail -f $LOG_DIR/qc-runner.log"
echo ""

# Wait for both to finish
wait $DISCOVER_PID
echo "[overnight] discover.py finished — $(date)"

wait $QC_PID
echo "[overnight] qc-runner.py finished — $(date)"

echo ""
echo "[overnight] Pipeline complete — $(date)"
