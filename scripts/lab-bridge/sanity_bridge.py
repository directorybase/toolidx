#!/usr/bin/env python3
"""
toolidx lab-side Sanity Panel bridge.

Replaces the Cloudflare-cron bridge in src/lib/sanityBridge.ts. That edge bridge
hit two walls in production (verified 2026-05-30):

  1. Cloudflare Workers cannot reach lab IPs (RFC1918 LAN nor Tailscale 100.x).
     The public tunnel works for light calls but /contents/jobs times out on the
     318-entry directory (Gitea enriches per-entry with last-commit metadata).
  2. Even past that, the scheduled handler hit "Exceeded CPU Limit" at ~62/317
     jobs — a 30s ceiling that can't sweep the full set in one tick.

This script runs lab-side (dragonstone) where neither constraint applies:
  - LAN/Tailscale to Gitea is fast and unmetered.
  - Cron has no CPU/wall-time cap.
  - The toolidx /internal/sanity-ingest endpoint was already built for an
    external pusher (X-API-Key auth, batches up to 100 rows).

Spec: outputs/2026-05-15-claude-toolidx-multi-agent-review-surface-plan-v11.md
Normalization logic mirrors src/lib/sanityBridge.ts normalizeJob() exactly.

Environment variables (REQUIRED):
  TOOLIDX_API_KEY   X-API-Key for POST /internal/sanity-ingest
  GITEA_TOKEN       token for agenticwatch-jobs read access

Environment variables (OPTIONAL):
  GITEA_BASE        default http://100.93.110.41:30008  (Tailscale)
  TOOLIDX_BASE      default https://toolidx.dev
  BRIDGE_MODE       dry-run | live | backfill  (default: dry-run)
  MAX_JOBS          int cap on job dirs processed (default: 1000)
  REQUEST_TIMEOUT   seconds per HTTP call (default: 30)

Usage:
    BRIDGE_MODE=dry-run python3 sanity_bridge.py
    BRIDGE_MODE=live    python3 sanity_bridge.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable

# ── config ────────────────────────────────────────────────────────────────

GITEA_BASE = os.environ.get("GITEA_BASE", "http://100.93.110.41:30008").rstrip("/")
GITEA_TOKEN = os.environ.get("GITEA_TOKEN", "")
JOBS_OWNER = "gitea_admin"
JOBS_REPO = "agenticwatch-jobs"
JOBS_BRANCH = "main"

TOOLIDX_BASE = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev").rstrip("/")
TOOLIDX_API_KEY = os.environ.get("TOOLIDX_API_KEY", "")

BRIDGE_MODE = os.environ.get("BRIDGE_MODE", "dry-run")
MAX_JOBS = int(os.environ.get("MAX_JOBS", "1000"))
REQUEST_TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT", "30"))
BATCH_SIZE = 100  # /internal/sanity-ingest hard cap

# Single source of truth — must match src/lib/composite.ts AGENT_TO_LENS.
AGENT_TO_LENS = {
    "a": "accuracy",
    "b": "use-case-fit",
    "c": "completeness",
    "d": "practical-implementation",
    "e": "authority",
}

VALID_MODES = ("dry-run", "live", "backfill")


# ── helpers ───────────────────────────────────────────────────────────────


def log(msg: str) -> None:
    sys.stdout.write(f"sanity-bridge: {msg}\n")
    sys.stdout.flush()


def warn(msg: str) -> None:
    sys.stderr.write(f"sanity-bridge: WARN {msg}\n")
    sys.stderr.flush()


def derive_server_id(repository_url: str) -> str:
    """Mirror of src/lib/id.ts deriveServerId."""
    s = re.sub(r"^https?://", "", repository_url)
    s = re.sub(r"\.git$", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s, flags=re.IGNORECASE).lower()
    return s.strip("-")


def gitea_get(path: str) -> tuple[int, bytes]:
    """GET against Gitea; returns (status, body). 404 returns (404, b'')."""
    url = f"{GITEA_BASE}{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"token {GITEA_TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return resp.getcode(), resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 404, b""
        warn(f"gitea_get {path} HTTP {e.code}")
        return e.code, b""
    except urllib.error.URLError as e:
        warn(f"gitea_get {path} URLError {e}")
        return 0, b""


def gitea_get_json(path: str) -> Any:
    code, body = gitea_get(path)
    if code == 404:
        return None
    if code != 200 or not body:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        warn(f"gitea_get_json {path} parse failed: {e}")
        return None


# ── Gitea readers ─────────────────────────────────────────────────────────


def list_job_dirs(max_jobs: int) -> list[str]:
    """
    List job dir names under jobs/ via the Git Trees API.

    The /contents/{dir} API enriches every entry with last-commit metadata
    before paginating — for the 318-entry jobs/ dir this takes >60s on the
    LAN and >110s through the tunnel (verified 2026-05-30). Git Trees
    returns raw {path,type,sha} entries with no enrichment.

    Three calls per refresh: branch HEAD → root tree → jobs subtree.
    """
    branch_path = f"/api/v1/repos/{JOBS_OWNER}/{JOBS_REPO}/branches/{JOBS_BRANCH}"
    branch_body = gitea_get_json(branch_path)
    if not isinstance(branch_body, dict):
        warn("list_job_dirs: branch endpoint returned non-dict")
        return []
    commit = branch_body.get("commit") or {}
    commit_sha = commit.get("id") if isinstance(commit, dict) else None
    if not isinstance(commit_sha, str) or not commit_sha:
        warn("list_job_dirs: missing commit.id on branch response")
        return []

    jobs_sha = _find_subtree_sha(commit_sha, "jobs")
    if not jobs_sha:
        warn("list_job_dirs: 'jobs' subtree not found in root tree")
        return []

    return _list_subtree_dirs(jobs_sha, max_jobs)


def _git_trees_page(tree_sha: str, page: int) -> dict[str, Any] | None:
    path = (
        f"/api/v1/repos/{JOBS_OWNER}/{JOBS_REPO}/git/trees/{tree_sha}"
        f"?page={page}&per_page=1000"
    )
    body = gitea_get_json(path)
    return body if isinstance(body, dict) else None


def _find_subtree_sha(tree_sha: str, name: str) -> str | None:
    page = 1
    while page <= 20:
        body = _git_trees_page(tree_sha, page)
        if body is None:
            return None
        entries = body.get("tree") or []
        if not isinstance(entries, list):
            return None
        for e in entries:
            if isinstance(e, dict) and e.get("path") == name and e.get("type") == "tree":
                sha = e.get("sha")
                return sha if isinstance(sha, str) else None
        if not entries or not body.get("truncated"):
            return None
        page += 1
    return None


def _list_subtree_dirs(tree_sha: str, max_jobs: int) -> list[str]:
    out: list[str] = []
    page = 1
    while len(out) < max_jobs and page <= 20:
        body = _git_trees_page(tree_sha, page)
        if body is None:
            break
        entries = body.get("tree") or []
        if not isinstance(entries, list) or not entries:
            break
        for e in entries:
            if isinstance(e, dict) and e.get("type") == "tree":
                path = e.get("path")
                if isinstance(path, str):
                    out.append(path)
            if len(out) >= max_jobs:
                break
        if not body.get("truncated"):
            break
        page += 1
    return out


def list_crosscheck_agent_dirs(job: str) -> list[str]:
    path = (
        f"/api/v1/repos/{JOBS_OWNER}/{JOBS_REPO}/contents/jobs/"
        f"{urllib.parse.quote(job)}/crosscheck?ref={JOBS_BRANCH}"
    )
    body = gitea_get_json(path)
    if not isinstance(body, list):
        return []
    return [
        e["name"]
        for e in body
        if isinstance(e, dict)
        and e.get("type") == "dir"
        and re.fullmatch(r"agent_[a-e]", e.get("name", ""))
    ]


def fetch_job_json(job: str, rel_path: str) -> Any:
    path = (
        f"/api/v1/repos/{JOBS_OWNER}/{JOBS_REPO}/raw/jobs/"
        f"{urllib.parse.quote(job)}/{rel_path}?ref={JOBS_BRANCH}"
    )
    return gitea_get_json(path)


# ── normalization (mirror of TS normalizeJob) ─────────────────────────────


def pick_string(*candidates: Any, default: str = "") -> str:
    for c in candidates:
        if isinstance(c, str) and c:
            return c
    return default


def pick_nullable_string(v: Any, max_len: int) -> str | None:
    if not isinstance(v, str):
        return None
    return v[:max_len]


def coerce_pass_file(
    server_id: str, letter: str, lens: str, pass_n: int, raw: Any, fallback_ts: str
) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    return {
        "server_id": server_id,
        "agent": letter,
        "model": pick_string(raw.get("model"), default="unknown"),
        "lens": lens,
        "pass": pass_n,
        "notes": None,
        "description": pick_nullable_string(raw.get("description"), 8000),
        "created_at": pick_string(raw.get("written_at"), default=fallback_ts),
    }


def normalize_job(
    job: str, server_id: str, status: Any, fallback_ts: str
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    status_obj = status if isinstance(status, dict) else None

    for dir_name in list_crosscheck_agent_dirs(job):
        letter = dir_name.removeprefix("agent_")
        lens = AGENT_TO_LENS.get(letter)
        if not lens:
            continue

        p1 = fetch_job_json(job, f"crosscheck/{dir_name}/pass1.json")
        r1 = coerce_pass_file(server_id, letter, lens, 1, p1, fallback_ts)
        if r1:
            out.append(r1)

        agent_ledger = (
            status_obj.get(f"agent_{letter}")
            if isinstance(status_obj, dict)
            else None
        )
        pass3_done = isinstance(agent_ledger, dict) and agent_ledger.get("pass3") is True

        if not pass3_done:
            if BRIDGE_MODE == "dry-run":
                state = "false" if isinstance(agent_ledger, dict) else "absent"
                log(
                    f"job={job} agent={letter} pass3 SKIPPED "
                    f"(status.agent_{letter}.pass3={state}) — no GET issued"
                )
            continue

        p3 = fetch_job_json(job, f"crosscheck/{dir_name}/pass3.json")
        if p3 is None:
            warn(
                f"HALT-SIGNAL job={job} agent={letter} — status.pass3=true but "
                f"crosscheck/{dir_name}/pass3.json is absent; layout differs from v11 §1 "
                f"(do NOT flip BRIDGE_MODE=live)"
            )
            continue

        r3 = coerce_pass_file(server_id, letter, lens, 3, p3, fallback_ts)
        if r3:
            out.append(r3)

    return out


# ── toolidx ingest ────────────────────────────────────────────────────────


def post_batch(rows: list[dict[str, Any]], mode: str) -> dict[str, Any] | None:
    """POST one batch (≤100 rows) to /internal/sanity-ingest. Returns parsed JSON or None."""
    url = f"{TOOLIDX_BASE}/internal/sanity-ingest"
    payload = json.dumps({"rows": rows, "mode": mode}).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-API-Key": TOOLIDX_API_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        warn(f"post_batch HTTP {e.code}: {body}")
        return None
    except urllib.error.URLError as e:
        warn(f"post_batch URLError {e}")
        return None


def chunked(seq: list[dict[str, Any]], n: int) -> Iterable[list[dict[str, Any]]]:
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


# ── main ──────────────────────────────────────────────────────────────────


def main() -> int:
    if BRIDGE_MODE not in VALID_MODES:
        sys.stderr.write(
            f"sanity-bridge: invalid BRIDGE_MODE={BRIDGE_MODE!r} (want one of {VALID_MODES})\n"
        )
        return 2
    if not GITEA_TOKEN:
        sys.stderr.write("sanity-bridge: GITEA_TOKEN not set\n")
        return 2
    if BRIDGE_MODE != "dry-run" and not TOOLIDX_API_KEY:
        sys.stderr.write(
            "sanity-bridge: TOOLIDX_API_KEY required for mode={}\n".format(BRIDGE_MODE)
        )
        return 2

    log(f"starting run mode={BRIDGE_MODE} max_jobs={MAX_JOBS} gitea={GITEA_BASE}")
    started = time.monotonic()

    job_dirs = list_job_dirs(MAX_JOBS)
    log(f"listed {len(job_dirs)} job dirs")

    all_rows: list[dict[str, Any]] = []
    fallback_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    jobs_with_describe = 0
    jobs_with_rows = 0
    normalizer_failed = 0
    touched_server_ids: set[str] = set()

    for job in job_dirs:
        describe = fetch_job_json(job, "describe.job.json")
        if not isinstance(describe, dict):
            continue
        jobs_with_describe += 1

        product_url = describe.get("product_url")
        if not isinstance(product_url, str) or not product_url:
            continue
        server_id = derive_server_id(product_url)
        if not server_id:
            continue

        status = fetch_job_json(job, "crosscheck/status.json")

        try:
            rows = normalize_job(job, server_id, status, fallback_ts)
        except Exception as e:  # defensive — match TS try/catch behavior
            normalizer_failed += 1
            warn(f"normalizer failed for job={job} server={server_id}: {e}")
            continue

        if not rows:
            continue
        jobs_with_rows += 1
        all_rows.extend(rows)
        touched_server_ids.add(server_id)

    elapsed = time.monotonic() - started
    log(
        f"normalized {len(all_rows)} rows across {len(touched_server_ids)} servers "
        f"({jobs_with_rows}/{len(job_dirs)} jobs produced rows, "
        f"{normalizer_failed} normalizer failures) in {elapsed:.1f}s"
    )

    if BRIDGE_MODE == "dry-run":
        # AC-BRIDGE samples: one (agent, pass) tuple each, with lens.
        seen: set[str] = set()
        samples: list[dict[str, Any]] = []
        for r in all_rows:
            k = f"{r['agent']}/{r['pass']}"
            if k in seen:
                continue
            seen.add(k)
            samples.append(
                {
                    "agent": r["agent"],
                    "pass": r["pass"],
                    "lens": r["lens"],
                    "description": (r["description"] or "")[:200],
                }
            )
        log("DRY-RUN samples per (agent, pass) [lens must match AGENT_TO_LENS]:")
        sys.stdout.write(json.dumps(samples, indent=2) + "\n")
        log("DRY-RUN: no POST issued; rerun with BRIDGE_MODE=live to write")
        return 0

    # live / backfill — POST batches.
    accepted = 0
    orphans: list[str] = []
    other_errors: list[dict[str, Any]] = []
    for batch in chunked(all_rows, BATCH_SIZE):
        # Even in live/backfill the ingest endpoint takes a top-level mode.
        # For backfill we still POST mode="backfill" so server-side triage logs.
        resp = post_batch(batch, BRIDGE_MODE)
        if not resp or not resp.get("success"):
            warn(f"batch of {len(batch)} rows had no successful response")
            continue
        r = resp.get("result", {})
        accepted += int(r.get("accepted", 0))
        orphans.extend(r.get("rejected_orphans", []) or [])
        other_errors.extend(r.get("rejected_other", []) or [])

    log(
        f"done — accepted={accepted} orphans={len(orphans)} "
        f"other_errors={len(other_errors)} servers_touched={len(touched_server_ids)}"
    )
    if orphans:
        warn(f"rejected_orphans (first 10): {orphans[:10]}")
    if other_errors:
        warn(f"rejected_other (first 3): {other_errors[:3]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
