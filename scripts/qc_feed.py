#!/usr/bin/env python3
"""
QC feed — pages toolidx API for servers needing a QC run and dispatches
GitHub Actions batches (200 per run, max 256 matrix limit).

Retest triggers (priority order):
  1. qc_status = pending                (never tested)
  2. qc_status = error, tested >7d ago  (transient failure retry)
  3. qc_status = failed, tested >14d ago (regression check)
  4. qc_status = passed, tested >30d ago (staleness refresh)

Usage:
    python3 scripts/qc_feed.py [--dry-run] [--batch-size 200] [--max-batches 4]

Environment:
    GITHUB_TOKEN    Required — fine-grained PAT with Actions: write
    TOOLIDX_BASE    Default: https://toolidx.dev
    GH_REPO         Default: directorybase/toolidx
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

TOOLIDX_BASE = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")
GH_REPO = os.environ.get("GH_REPO", "directorybase/toolidx")
WORKFLOW_FILE = "qc-sanity.yml"

STALE_PASSED_DAYS = 30
RETRY_ERROR_DAYS = 7
RETRY_FAILED_DAYS = 14


def fetch_servers(status: str, qc_status: str, limit: int = 100) -> list[dict]:
    ids = []
    page = 1
    while True:
        url = f"{TOOLIDX_BASE}/v1/servers?status={status}&qc_status={qc_status}&limit={limit}&page={page}"
        out = subprocess.run(
            ["curl", "-s", "--max-time", "15", url],
            capture_output=True, text=True,
        ).stdout
        data = json.loads(out)
        batch = data.get("result", [])
        if not batch:
            break
        ids.extend(batch)
        if len(ids) >= data.get("total", 0):
            break
        page += 1
    return ids


def is_stale(record: dict, days: int) -> bool:
    tested_at = record.get("updated_at")
    if not tested_at:
        return True
    try:
        dt = datetime.fromisoformat(tested_at.replace("Z", "+00:00"))
        return datetime.now(timezone.utc) - dt > timedelta(days=days)
    except ValueError:
        return True


def collect_candidates(max_total: int) -> list[str]:
    candidates = []

    # 1. Never tested
    print("[feed] Fetching pending servers...", flush=True)
    pending = fetch_servers("active", "pending")
    candidates.extend(r["id"] for r in pending)
    print(f"[feed]   pending: {len(pending)}", flush=True)

    if len(candidates) >= max_total:
        return candidates[:max_total]

    # 2. Transient error retry (>7d)
    print("[feed] Fetching error servers...", flush=True)
    errors = fetch_servers("active", "error")
    stale_errors = [r["id"] for r in errors if is_stale(r, RETRY_ERROR_DAYS)]
    candidates.extend(stale_errors)
    print(f"[feed]   error (>{RETRY_ERROR_DAYS}d): {len(stale_errors)}", flush=True)

    if len(candidates) >= max_total:
        return candidates[:max_total]

    # 3. Failed regression check (>14d)
    print("[feed] Fetching failed servers...", flush=True)
    failed = fetch_servers("active", "failed")
    stale_failed = [r["id"] for r in failed if is_stale(r, RETRY_FAILED_DAYS)]
    candidates.extend(stale_failed)
    print(f"[feed]   failed (>{RETRY_FAILED_DAYS}d): {len(stale_failed)}", flush=True)

    if len(candidates) >= max_total:
        return candidates[:max_total]

    # 4. Passed but stale (>30d)
    print("[feed] Fetching stale passed servers...", flush=True)
    passed = fetch_servers("active", "passed")
    stale_passed = [r["id"] for r in passed if is_stale(r, STALE_PASSED_DAYS)]
    candidates.extend(stale_passed)
    print(f"[feed]   passed stale (>{STALE_PASSED_DAYS}d): {len(stale_passed)}", flush=True)

    return candidates[:max_total]


def dispatch_batch(server_ids: list[str], dry_run: bool) -> bool:
    payload = json.dumps(server_ids)
    print(f"\n[feed] Dispatching {len(server_ids)} servers to {GH_REPO}/{WORKFLOW_FILE}", flush=True)
    if dry_run:
        print(f"[feed] DRY RUN — would dispatch: {server_ids[:3]}...", flush=True)
        return True

    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("[feed] ERROR: GITHUB_TOKEN not set", flush=True)
        return False

    proc = subprocess.run(
        [
            "curl", "-s", "-X", "POST",
            f"https://api.github.com/repos/{GH_REPO}/actions/workflows/{WORKFLOW_FILE}/dispatches",
            "-H", "Accept: application/vnd.github+json",
            "-H", f"Authorization: Bearer {token}",
            "-H", "X-GitHub-Api-Version: 2022-11-28",
            "-d", json.dumps({"ref": "main", "inputs": {"server_ids": payload}}),
        ],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or proc.stdout.strip():
        print(f"[feed] Dispatch response: {proc.stdout}", flush=True)
        return False
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--max-batches", type=int, default=4)
    args = parser.parse_args()

    max_total = args.batch_size * args.max_batches
    print(f"[feed] Collecting up to {max_total} candidates...", flush=True)

    candidates = collect_candidates(max_total)
    print(f"\n[feed] Total candidates: {len(candidates)}", flush=True)

    if not candidates:
        print("[feed] Nothing to test.", flush=True)
        sys.exit(0)

    batches = [
        candidates[i:i + args.batch_size]
        for i in range(0, len(candidates), args.batch_size)
    ]

    ok = 0
    for i, batch in enumerate(batches):
        print(f"\n[feed] Batch {i + 1}/{len(batches)} ({len(batch)} servers)", flush=True)
        if dispatch_batch(batch, args.dry_run):
            ok += 1
        else:
            print(f"[feed] Batch {i + 1} failed — stopping.", flush=True)
            break

    print(f"\n[feed] Done — {ok}/{len(batches)} batches dispatched.", flush=True)


if __name__ == "__main__":
    main()
