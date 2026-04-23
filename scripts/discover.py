#!/usr/bin/env python3
"""
Discovery agent — finds install commands for toolidx servers that don't have them.

Reads servers from toolidx API, checks GitHub for package.json / pyproject.toml,
verifies against npm/PyPI, then PATCHes install_command + package_type back.

Run on Robodorm:
    GITHUB_TOKEN=ghp_... TOOLIDX_API_KEY=... python3 scripts/discover.py

Environment:
    GITHUB_TOKEN      Required — without it GitHub rate-limits to 60/hr (too slow)
    TOOLIDX_API_KEY   Required — write access to toolidx
    TOOLIDX_BASE      Optional — default https://toolidx.dev
"""

import base64
import json
import os
import re
import subprocess
import sys
import time
import tomllib
import urllib.request
import urllib.error
from typing import Optional

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
TOOLIDX_API_KEY = os.environ.get("TOOLIDX_API_KEY", "")
TOOLIDX_BASE = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")

GITHUB_API = "https://api.github.com"
NPM_REGISTRY = "https://registry.npmjs.org"
PYPI_API = "https://pypi.org/pypi"

RATE_LIMIT_SLEEP = 0.75  # seconds between GitHub API calls


def github_headers() -> dict:
    h = {"Accept": "application/vnd.github.v3+json", "User-Agent": "toolidx-discover/1.0"}
    if GITHUB_TOKEN:
        h["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    return h


def fetch_json_curl(url: str, headers: dict = None, timeout: int = 10) -> Optional[dict]:
    """Use curl — avoids Cloudflare bot blocks that affect Python urllib."""
    cmd = ["curl", "-s", "--max-time", str(timeout), url]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
        if not proc.stdout.strip():
            return None
        return json.loads(proc.stdout)
    except Exception:
        return None


def fetch_json(url: str, headers: dict = None, timeout: int = 10) -> Optional[dict]:
    """GitHub/npm/PyPI — urllib is fine (no Cloudflare). toolidx calls use fetch_json_curl."""
    try:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code in (404, 403, 429):
            return None
        return None
    except Exception:
        return None


def fetch_github_file(owner: str, repo: str, path: str) -> Optional[str]:
    """Fetch a file from GitHub and return its decoded text content."""
    url = f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}"
    data = fetch_json(url, headers=github_headers())
    time.sleep(RATE_LIMIT_SLEEP)
    if not data or data.get("type") != "file":
        return None
    try:
        return base64.b64decode(data["content"]).decode("utf-8", errors="replace")
    except Exception:
        return None


def parse_repo_url(url: str) -> Optional[tuple[str, str]]:
    """Extract (owner, repo) from a GitHub URL."""
    m = re.match(r"https?://github\.com/([^/]+)/([^/?.#]+)", url)
    if not m:
        return None
    return m.group(1), m.group(2).rstrip("/")


def check_npm_exists(package_name: str) -> bool:
    url = f"{NPM_REGISTRY}/{urllib.request.quote(package_name, safe='@/')}"
    data = fetch_json(url)
    return data is not None and "error" not in data


def check_pypi_exists(package_name: str) -> bool:
    url = f"{PYPI_API}/{package_name}/json"
    data = fetch_json(url)
    return data is not None


def discover_npm(owner: str, repo: str) -> Optional[dict]:
    """Try to find npm package info from package.json."""
    paths = ["package.json", f"src/{repo}/package.json", f"packages/{repo}/package.json"]
    for path in paths:
        content = fetch_github_file(owner, repo, path)
        if not content:
            continue
        try:
            pkg = json.loads(content)
        except json.JSONDecodeError:
            continue
        name = pkg.get("name")
        if not name:
            continue
        engines = pkg.get("engines", {})
        node_ver = engines.get("node") if isinstance(engines, dict) else None
        # Verify published on npm
        if check_npm_exists(name):
            return {
                "package_name": name,
                "install_command": f"npx -y {name}",
                "package_type": "npm",
                "min_node_version": node_ver,
            }
    return None


def discover_python(owner: str, repo: str) -> Optional[dict]:
    """Try to find Python package info from pyproject.toml or setup.py."""
    # Try pyproject.toml first
    content = fetch_github_file(owner, repo, "pyproject.toml")
    if content:
        try:
            data = tomllib.loads(content)
            name = (data.get("project", {}) or data.get("tool", {}).get("poetry", {})).get("name")
            if name and check_pypi_exists(name):
                return {
                    "package_name": name,
                    "install_command": f"uvx {name}",
                    "package_type": "uvx",
                    "min_node_version": None,
                }
        except Exception:
            pass

    # Try setup.py — extract name with regex (avoid exec)
    content = fetch_github_file(owner, repo, "setup.py")
    if content:
        m = re.search(r'name\s*=\s*["\']([^"\']+)["\']', content)
        if m:
            name = m.group(1)
            if check_pypi_exists(name):
                return {
                    "package_name": name,
                    "install_command": f"pip install {name}",
                    "package_type": "pip",
                    "min_node_version": None,
                }

    return None


def patch_server(server_id: str, fields: dict) -> bool:
    proc = subprocess.run(
        [
            "curl", "-s", "-X", "PATCH",
            f"{TOOLIDX_BASE}/v1/servers/{server_id}",
            "-H", "Content-Type: application/json",
            "-H", f"X-API-Key: {TOOLIDX_API_KEY}",
            "-d", json.dumps(fields),
        ],
        capture_output=True, text=True, timeout=15,
    )
    try:
        return json.loads(proc.stdout).get("success", False)
    except Exception:
        return False


def get_servers_page(offset: int, limit: int = 100) -> tuple[list, int]:
    url = f"{TOOLIDX_BASE}/v1/servers?qc_status=pending&status=active&limit={limit}&offset={offset}"
    data = fetch_json_curl(url)
    if not data:
        return [], 0
    return data.get("result", []), data.get("total", 0)


def main():
    if not GITHUB_TOKEN:
        print("WARNING: GITHUB_TOKEN not set — rate limited to 60 req/hr. Will be very slow.")
    if not TOOLIDX_API_KEY:
        sys.exit("Error: TOOLIDX_API_KEY required")

    print(f"[discover] Starting — target: {TOOLIDX_BASE}")

    offset = 0
    limit = 100
    discovered = 0
    skipped = 0
    failed = 0
    processed = 0

    _, total = get_servers_page(0, 1)
    print(f"[discover] {total} pending servers to process\n")

    while True:
        servers, total = get_servers_page(offset, limit)
        if not servers:
            break

        for server in servers:
            # Skip servers that already have install_command
            if server.get("install_command"):
                skipped += 1
                processed += 1
                continue

            repo_url = server.get("repository_url", "") or ""
            server_id = server["id"]

            parsed = parse_repo_url(repo_url)
            if not parsed:
                skipped += 1
                processed += 1
                if processed % 100 == 0:
                    print(f"  [{processed}/{total}] discovered={discovered} skipped={skipped} failed={failed}")
                continue

            owner, repo = parsed

            # Try npm first (most MCP servers are npm)
            result = discover_npm(owner, repo)
            if not result:
                result = discover_python(owner, repo)

            if result:
                fields = {k: v for k, v in result.items() if v is not None}
                ok = patch_server(server_id, fields)
                if ok:
                    discovered += 1
                    print(f"  ✓ {server_id} → {result['install_command']}")
                else:
                    failed += 1
                    print(f"  ✗ {server_id} — PATCH failed")
            else:
                skipped += 1

            processed += 1
            if processed % 50 == 0:
                print(f"  [{processed}/{total}] discovered={discovered} skipped={skipped} failed={failed}")

        offset += limit
        if offset >= total:
            break

    print(f"\n[discover] Done: {discovered} discovered, {skipped} skipped (no package found), {failed} failed")


if __name__ == "__main__":
    main()
