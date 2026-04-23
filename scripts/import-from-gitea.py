#!/usr/bin/env python3
"""
Import MCP server listings from agenticwatch-site/data/mcp-servers.json into toolidx.

Usage:
    python3 scripts/import-from-gitea.py [--dry-run] [--limit N]

Options:
    --dry-run   Print what would be imported without posting
    --limit N   Import only first N entries (default: all)
"""

import argparse
import base64
import json
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from typing import Optional

GITEA_TOKEN = "fa77ce8bdee8c61944734e35202cffddb7cf6919"
GITEA_BASE = "http://192.168.7.70:30008/api/v1"
GITEA_REPO = "directorybase/agenticwatch-site"
MCP_SERVERS_PATH = "data/mcp-servers.json"

TOOLIDX_BASE = "https://toolidx.gregorydcollins.workers.dev"
TOOLIDX_API_KEY = "2778e5e9c0d621451af9f92e7b0b8dfc7ac7f8e87e9c3a218ef527d652de7742"


def derive_server_id(url: str) -> Optional[str]:
    """Slug from repository URL — matches src/lib/id.ts logic."""
    if not url:
        return None
    slug = re.sub(r"^https?://", "", url)
    slug = re.sub(r"\.git$", "", slug)
    slug = re.sub(r"[^a-z0-9]+", "-", slug, flags=re.IGNORECASE).lower()
    slug = slug.strip("-")
    return slug if slug else None


def fetch_mcp_servers() -> list:
    url = f"{GITEA_BASE}/repos/{GITEA_REPO}/contents/{MCP_SERVERS_PATH}?token={GITEA_TOKEN}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    content = json.loads(base64.b64decode(data["content"]).decode())
    return content["entries"]


REPO_HOSTS = ("github.com", "gitlab.com", "codeberg.org")


def post_server(entry: dict, dry_run: bool) -> tuple[bool, str]:
    url = entry.get("url", "")
    if not any(h in url for h in REPO_HOSTS):
        return False, "not a repo URL"

    server_id = derive_server_id(url)
    if not server_id:
        return False, "no derivable ID"

    payload = {
        "id": server_id,
        "name": entry["name"],
        "description": entry.get("description") or "",
        "repository_url": entry.get("url"),
        "tags": entry.get("tags") or [],
        "source": "gitea-import",
        "status": "active",
    }

    if dry_run:
        print(f"  [dry-run] Would import: {server_id}")
        return True, "dry-run"

    try:
        result = subprocess.run(
            [
                "curl", "-s", "-X", "POST",
                f"{TOOLIDX_BASE}/v1/servers",
                "-H", "Content-Type: application/json",
                "-H", f"X-API-Key: {TOOLIDX_API_KEY}",
                "-d", json.dumps(payload),
            ],
            capture_output=True, text=True, timeout=15,
        )
        data = json.loads(result.stdout)
        return data.get("success", False), data.get("result", {}).get("id", "")
    except Exception as ex:
        return False, str(ex)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    print("Fetching mcp-servers.json from Gitea...")
    entries = fetch_mcp_servers()
    if args.limit:
        entries = entries[: args.limit]
    print(f"Found {len(entries)} entries to process\n")

    ok = 0
    skipped = 0
    failed = 0

    for i, entry in enumerate(entries, 1):
        success, detail = post_server(entry, args.dry_run)
        if success:
            ok += 1
            if i % 50 == 0:
                print(f"  [{i}/{len(entries)}] {ok} imported, {skipped} skipped, {failed} failed")
        elif detail == "no derivable ID":
            skipped += 1
        else:
            failed += 1
            print(f"  FAIL [{i}] {entry.get('name', '?')}: {detail}")

        if not args.dry_run and i % 10 == 0:
            time.sleep(0.2)  # be gentle with the worker

    print(f"\nDone: {ok} imported, {skipped} skipped (no ID), {failed} failed")


if __name__ == "__main__":
    main()
