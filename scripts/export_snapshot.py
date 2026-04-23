#!/usr/bin/env python3
"""
export_snapshot.py — Export all toolidx server records to snapshots/latest.json.
Commits the snapshot to Gitea for local backup ownership.

Usage:
    python3 scripts/export_snapshot.py

Environment:
    TOOLIDX_BASE   Base URL (default: https://toolidx.dev)
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

TOOLIDX_BASE = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")
PAGE_SIZE = 100


def curl_get(url: str) -> dict:
    proc = subprocess.run(
        ["curl", "-s", "--max-time", "30", url],
        capture_output=True, text=True, timeout=35,
    )
    return json.loads(proc.stdout)


def fetch_all_servers() -> list:
    servers = []
    page = 1
    while True:
        url = f"{TOOLIDX_BASE}/v1/servers?limit={PAGE_SIZE}&page={page}"
        data = curl_get(url)
        # Handle both {result: [...]} and {servers: [...]} response shapes
        batch = data.get("result") if isinstance(data.get("result"), list) else data.get("servers", [])
        if not batch:
            break
        servers.extend(batch)
        print(f"  page {page}: {len(batch)} servers (running total: {len(servers)})", flush=True)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
        time.sleep(0.2)  # be gentle to the API
    return servers


def main():
    print(f"[snapshot] Fetching from {TOOLIDX_BASE}...", flush=True)
    servers = fetch_all_servers()
    print(f"[snapshot] {len(servers)} servers fetched", flush=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    snapshot = {
        "timestamp": timestamp,
        "server_count": len(servers),
        "source": TOOLIDX_BASE,
        "servers": servers,
    }

    os.makedirs("snapshots", exist_ok=True)
    with open("snapshots/latest.json", "w") as f:
        json.dump(snapshot, f, indent=2)
    print("[snapshot] Written: snapshots/latest.json", flush=True)

    # Commit and push to Gitea (origin)
    try:
        result = subprocess.run(["git", "add", "snapshots/latest.json"], check=True)
        diff = subprocess.run(["git", "diff", "--cached", "--stat"], capture_output=True, text=True)
        if not diff.stdout.strip():
            print("[snapshot] No changes — snapshot identical to last run", flush=True)
            return
        subprocess.run(
            ["git", "commit", "-m", f"snapshot: {date_str} — {len(servers)} servers"],
            check=True,
        )
        subprocess.run(["git", "push", "origin", "main"], check=True)
        print("[snapshot] Committed and pushed to Gitea", flush=True)
    except subprocess.CalledProcessError as e:
        print(f"[snapshot] Git error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
