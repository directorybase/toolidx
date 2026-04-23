#!/usr/bin/env python3
"""
npm version poller — detects npm package updates and requeues changed servers.

For each active server with an npm package_name, fetches the dist-tags.latest
from the npm registry and compares against the stored npm_version. When the
version has changed, updates npm_version and resets qc_status to 'pending'
so the next feed run picks it up for retesting.

Usage:
    python3 scripts/qc_npm_poller.py [--dry-run] [--workers 20] [--verbose]

Environment:
    TOOLIDX_API_KEY   Required — for PATCH calls
    TOOLIDX_BASE      Default: https://toolidx.dev
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

TOOLIDX_BASE = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")
NPM_REGISTRY = "https://registry.npmjs.org/-/package/{pkg}/dist-tags"


def fetch_servers_with_package() -> list[dict]:
    """Page through all active servers that have a package_name set."""
    servers = []
    page = 1
    while True:
        url = f"{TOOLIDX_BASE}/v1/servers?status=active&limit=100&page={page}"
        out = subprocess.run(
            ["curl", "-s", "--max-time", "15", url],
            capture_output=True, text=True,
        ).stdout
        data = json.loads(out)
        batch = data.get("result", [])
        if not batch:
            break
        for s in batch:
            pkg = s.get("package_name") or ""
            pkg_type = s.get("package_type") or ""
            if pkg and pkg_type == "npm":
                servers.append({
                    "id": s["id"],
                    "package_name": pkg,
                    "npm_version": s.get("npm_version"),
                    "qc_status": s.get("qc_status"),
                })
        if len(servers) >= data.get("total", 0):
            break
        page += 1
    return servers


def fetch_npm_latest(package_name: str) -> str | None:
    """Return dist-tags.latest for a package, or None on error."""
    url = NPM_REGISTRY.format(pkg=package_name)
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("latest")
    except (urllib.error.URLError, json.JSONDecodeError, KeyError):
        return None


def patch_server(server_id: str, npm_version: str, requeue: bool, api_key: str) -> bool:
    """Update npm_version and optionally reset qc_status to pending."""
    payload: dict = {"npm_version": npm_version}
    if requeue:
        payload["qc_status"] = "pending"

    with subprocess.Popen(
        [
            "curl", "-s", "-X", "PATCH",
            f"{TOOLIDX_BASE}/v1/servers/{server_id}",
            "-H", "Content-Type: application/json",
            "-H", f"X-API-Key: {api_key}",
            "-d", json.dumps(payload),
        ],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ) as proc:
        stdout, _ = proc.communicate(timeout=15)
    try:
        resp = json.loads(stdout)
        return resp.get("success", False)
    except json.JSONDecodeError:
        return False


def check_server(server: dict) -> dict:
    """Check one server. Returns a result dict."""
    pkg = server["package_name"]
    latest = fetch_npm_latest(pkg)
    stored = server["npm_version"]
    changed = latest is not None and latest != stored
    already_pending = server["qc_status"] == "pending"
    return {
        "id": server["id"],
        "package_name": pkg,
        "stored": stored,
        "latest": latest,
        "changed": changed,
        "requeue": changed and not already_pending,
        "error": latest is None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Check only, no PATCHes")
    parser.add_argument("--workers", type=int, default=20, help="Parallel npm fetch workers")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get("TOOLIDX_API_KEY", "")
    if not api_key and not args.dry_run:
        print("ERROR: TOOLIDX_API_KEY not set", flush=True)
        sys.exit(1)

    print("[poller] Fetching active npm servers...", flush=True)
    servers = fetch_servers_with_package()
    print(f"[poller] Found {len(servers)} servers with npm package_name", flush=True)

    if not servers:
        print("[poller] Nothing to check.", flush=True)
        return

    results = []
    print(f"[poller] Checking npm registry ({args.workers} workers)...", flush=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(check_server, s): s for s in servers}
        for fut in as_completed(futures):
            r = fut.result()
            results.append(r)
            if args.verbose or r["changed"] or r["error"]:
                tag = "CHANGED" if r["changed"] else ("ERROR" if r["error"] else "ok")
                print(
                    f"  [{tag}] {r['id']} — stored={r['stored']!r} latest={r['latest']!r}",
                    flush=True,
                )

    changed = [r for r in results if r["changed"]]
    requeue = [r for r in results if r["requeue"]]
    errors = [r for r in results if r["error"]]

    print(f"\n[poller] Summary:", flush=True)
    print(f"  checked:  {len(results)}", flush=True)
    print(f"  changed:  {len(changed)}", flush=True)
    print(f"  requeue:  {len(requeue)} (changed + not already pending)", flush=True)
    print(f"  errors:   {len(errors)} (npm registry unreachable or unknown pkg)", flush=True)

    if not requeue:
        print("[poller] Nothing to requeue.", flush=True)
        return

    print(f"\n[poller] Patching {len(requeue)} servers...", flush=True)
    ok = 0
    for r in requeue:
        if args.dry_run:
            print(f"  DRY RUN — would requeue {r['id']} ({r['stored']} → {r['latest']})", flush=True)
            ok += 1
            continue
        success = patch_server(r["id"], r["latest"], requeue=True, api_key=api_key)
        status = "ok" if success else "FAIL"
        print(f"  [{status}] {r['id']} ({r['stored']} → {r['latest']})", flush=True)
        if success:
            ok += 1

    print(f"\n[poller] Done — {ok}/{len(requeue)} requeued.", flush=True)


if __name__ == "__main__":
    main()
