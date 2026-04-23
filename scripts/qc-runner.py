#!/usr/bin/env python3
"""
QC Runner — parallel QC test worker for toolidx.

Polls toolidx for pending servers that have install_command set,
runs QC tests in parallel, PATCHes results back.

Designed to run alongside discover.py overnight on Robodorm.

Run:
    TOOLIDX_API_KEY=... python3 scripts/qc-runner.py [--workers 5]

Environment:
    TOOLIDX_API_KEY   Required
    TOOLIDX_BASE      Optional — default https://toolidx.dev
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

# Import QC logic from qc-test-single
sys.path.insert(0, os.path.dirname(__file__))
from qc_test_single import run_qc

TOOLIDX_API_KEY = os.environ.get("TOOLIDX_API_KEY", "")
TOOLIDX_BASE = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")

POLL_INTERVAL = 30   # seconds to wait when no work is available
BATCH_SIZE = 100     # servers per API fetch
QC_TIMEOUT = 60      # seconds per QC test before giving up


def fetch_json(url: str) -> Optional[dict]:
    """Use curl — avoids Cloudflare bot blocks that affect Python urllib."""
    try:
        proc = subprocess.run(
            ["curl", "-s", "--max-time", "15", url],
            capture_output=True, text=True, timeout=20,
        )
        return json.loads(proc.stdout) if proc.stdout.strip() else None
    except Exception:
        return None


def get_pending_with_install() -> list:
    """Fetch all pending servers that have an install_command."""
    results = []
    offset = 0
    while True:
        url = f"{TOOLIDX_BASE}/v1/servers?qc_status=pending&status=active&limit={BATCH_SIZE}&offset={offset}"
        data = fetch_json(url)
        if not data:
            break
        page = data.get("result", [])
        total = data.get("total", 0)
        for s in page:
            if s.get("install_command"):
                results.append(s)
        offset += BATCH_SIZE
        if offset >= total:
            break
    return results


def patch_qc_result(result: dict) -> bool:
    server_id = result["server_id"]
    payload = {
        "qc_status": result["qc_status"],
        "tool_schemas": result.get("tool_schemas") or [],
        "server_version": result.get("server_version"),
        "protocol_version": result.get("protocol_version"),
        "capabilities": result.get("capabilities"),
        "server_instructions": result.get("server_instructions"),
        "resources_list": result.get("resources_list"),
        "prompts_list": result.get("prompts_list"),
        "has_destructive_tools": result.get("has_destructive_tools", False),
        "all_tools_readonly": result.get("all_tools_readonly", False),
        "install_duration_ms": result.get("install_duration_ms"),
        "requires_env_vars": result.get("requires_env_vars", False),
        "description_quality_score": result.get("description_quality_score"),
        "external_deps_detected": result.get("external_deps_detected", []),
        "setup_complexity": result.get("setup_complexity", "low"),
    }
    if result.get("qc_error"):
        payload["qc_error"] = result["qc_error"]

    # Remove None values to keep payload clean
    payload = {k: v for k, v in payload.items() if v is not None}

    # Write payload to temp file — avoids "Argument list too long" for large tool schemas
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        tmp_path = f.name

    try:
        proc = subprocess.run(
            [
                "curl", "-s", "-X", "PATCH",
                f"{TOOLIDX_BASE}/v1/servers/{server_id}/qc",
                "-H", "Content-Type: application/json",
                "-H", f"X-API-Key: {TOOLIDX_API_KEY}",
                "-d", f"@{tmp_path}",
            ],
            capture_output=True, text=True, timeout=15,
        )
        resp = json.loads(proc.stdout)
        return resp.get("success", False)
    except Exception:
        return False
    finally:
        os.unlink(tmp_path)


def run_one(server: dict) -> dict:
    server_id = server["id"]
    install_cmd = server["install_command"]
    result = run_qc(install_cmd, server_id, verbose=False)
    ok = patch_qc_result(result)
    status = result["qc_status"]
    tools = result.get("tool_count", 0)
    quality = result.get("description_quality_score")
    q_str = f" quality={quality:.1f}" if quality else ""
    tick = "✓" if ok else "✗"
    print(f"  {tick} [{status}] {server_id} — {tools} tools{q_str}")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=5)
    args = parser.parse_args()

    if not TOOLIDX_API_KEY:
        sys.exit("Error: TOOLIDX_API_KEY required")

    print(f"[qc-runner] Starting — {args.workers} workers — target: {TOOLIDX_BASE}")

    total_run = 0
    total_passed = 0
    total_failed = 0

    while True:
        servers = get_pending_with_install()

        if not servers:
            print(f"[qc-runner] No pending servers with install_command. Waiting {POLL_INTERVAL}s...")
            time.sleep(POLL_INTERVAL)
            continue

        print(f"\n[qc-runner] {len(servers)} servers to test (passed={total_passed} failed={total_failed})")

        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {executor.submit(run_one, s): s for s in servers}
            for future in as_completed(futures):
                try:
                    result = future.result(timeout=QC_TIMEOUT + 10)
                    total_run += 1
                    if result["qc_status"] == "passed":
                        total_passed += 1
                    else:
                        total_failed += 1
                except Exception as e:
                    total_failed += 1
                    print(f"  ✗ Worker exception: {e}")

        # Brief pause then re-poll (discover.py may have found more)
        time.sleep(5)


if __name__ == "__main__":
    main()
