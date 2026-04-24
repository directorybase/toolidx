#!/usr/bin/env bash
# install.sh — Deploy the MLX arg-generator worker to the M3 MBA.
#
# Run from the Fortress or toolidx repo root on a machine that has SSH
# access to the M3 (192.168.7.225).
#
# Usage:
#   bash arg-generator/install.sh
#
# To override the target host:
#   TARGET_HOST=gregory@192.168.7.225 bash arg-generator/install.sh

set -euo pipefail

TARGET_HOST="${TARGET_HOST:-gregory@192.168.7.225}"
REMOTE_DIR="/Users/gregory/mcp-arg-generator"
PLIST_NAME="com.toolidx.arg-generator.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Deploying MLX arg-generator worker to ${TARGET_HOST}"
echo "    Local source : ${SCRIPT_DIR}"
echo "    Remote dir   : ${REMOTE_DIR}"

# ---------------------------------------------------------------------------
# 1. Create remote working directory
# ---------------------------------------------------------------------------
ssh "${TARGET_HOST}" "mkdir -p '${REMOTE_DIR}'"

# ---------------------------------------------------------------------------
# 2. Copy worker script
# ---------------------------------------------------------------------------
echo "==> Copying worker.py …"
scp "${SCRIPT_DIR}/worker.py" "${TARGET_HOST}:${REMOTE_DIR}/worker.py"

# ---------------------------------------------------------------------------
# 3. Create a Python venv and install dependencies (idempotent)
# ---------------------------------------------------------------------------
echo "==> Setting up Python venv and dependencies …"
ssh "${TARGET_HOST}" bash <<'REMOTE'
set -euo pipefail
REMOTE_DIR="/Users/gregory/mcp-arg-generator"
VENV="${REMOTE_DIR}/venv"

# Create venv if it doesn't already exist
if [ ! -d "${VENV}" ]; then
  python3 -m venv "${VENV}"
fi

# Activate and install/upgrade deps
source "${VENV}/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet mlx-lm redis requests jsonschema

echo "  Deps installed:"
pip show mlx-lm redis requests jsonschema | grep -E "^(Name|Version):"
REMOTE

# ---------------------------------------------------------------------------
# 4. Discover MLX model paths on the M3 and report
# ---------------------------------------------------------------------------
echo "==> Discovering MLX models on ${TARGET_HOST} …"
ssh "${TARGET_HOST}" bash <<'REMOTE'
echo "--- ~/models/ directory listing ---"
ls ~/models/ 2>/dev/null || echo "(~/models/ not found)"

echo ""
echo "--- Searching for Qwen/Llama config.json files ---"
find ~ -maxdepth 6 \( -name "config.json" \) 2>/dev/null \
  | xargs grep -l '"model_type"' 2>/dev/null \
  | grep -i "qwen\|llama" \
  | head -20 \
  || echo "(no matching models found)"
REMOTE

# ---------------------------------------------------------------------------
# 5. Install launchd plist
# ---------------------------------------------------------------------------
echo "==> Installing launchd plist …"
PLIST_DEST="/Users/gregory/Library/LaunchAgents/${PLIST_NAME}"

scp "${SCRIPT_DIR}/${PLIST_NAME}" "${TARGET_HOST}:${PLIST_DEST}"

# Unload any previous version first (ignore errors if not loaded)
ssh "${TARGET_HOST}" bash <<REMOTE
set -euo pipefail
PLIST_DEST="${PLIST_DEST}"
PLIST_LABEL="com.toolidx.arg-generator"

# Bootout is idempotent — ignore errors if not loaded
launchctl bootout "gui/\$(id -u)/\${PLIST_LABEL}" 2>/dev/null || true

# Bootstrap the new plist
launchctl bootstrap "gui/\$(id -u)" "\${PLIST_DEST}"
echo "  launchd service bootstrapped: \${PLIST_LABEL}"
REMOTE

# ---------------------------------------------------------------------------
# 6. Verify the service started
# ---------------------------------------------------------------------------
echo "==> Checking service status …"
ssh "${TARGET_HOST}" "launchctl print gui/\$(id -u)/com.toolidx.arg-generator 2>/dev/null || launchctl list | grep toolidx || echo '(service not visible yet — check log)'"

echo ""
echo "==> Done. Tail the log with:"
echo "    ssh ${TARGET_HOST} 'tail -f ${REMOTE_DIR}/worker.log'"
