#!/usr/bin/env python3
"""
One-shot backfill of servers.failure_class for historical rows.

Walks every server with qc_status in (failed, error, skipped, passed-with-zero-tools),
runs qc_classify.classify_failure() against the stored qc_error + flags, and
PATCHes failure_class back to toolidx.

Idempotent — safe to re-run.

Usage:
    TOOLIDX_API_KEY=... python3 scripts/backfill_failure_class.py
    TOOLIDX_API_KEY=... python3 scripts/backfill_failure_class.py --dry-run
"""

import argparse
import json
import os
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qc_classify import classify_failure  # noqa: E402

BASE_URL = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")
PAGE_SIZE = 200


def fetch_page(offset: int) -> list[dict]:
    """Fetch a page of servers. Returns the result list."""
    url = f"{BASE_URL}/v1/servers?limit={PAGE_SIZE}&offset={offset}"
    p = subprocess.run(
        ["curl", "-s", "--max-time", "20", url],
        capture_output=True, text=True, timeout=25,
    )
    data = json.loads(p.stdout)
    return data.get("result", [])


def fetch_full(server_id: str) -> dict | None:
    """Fetch full server record (list endpoint omits qc_error etc.)."""
    p = subprocess.run(
        ["curl", "-s", "--max-time", "15",
         f"{BASE_URL}/v1/servers/{server_id}?slim=true"],
        capture_output=True, text=True, timeout=20,
    )
    try:
        data = json.loads(p.stdout)
        return data.get("result")
    except Exception:
        return None


def patch_failure_class(server_id: str, failure_class: str | None,
                        api_key: str) -> bool:
    """PATCH only the failure_class field via /qc endpoint."""
    payload = {
        "qc_status": None,  # placeholder; we only update failure_class
        "failure_class": failure_class,
    }
    # /qc endpoint requires qc_status; we'll fetch current and resend it
    return _do_patch(server_id, payload, api_key)


def _do_patch(server_id: str, payload: dict, api_key: str) -> bool:
    """Run the curl PATCH and return success bool."""
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        tmp = f.name
    try:
        p = subprocess.run(
            [
                "curl", "-s", "-w", "\n%{http_code}",
                "-X", "PATCH",
                f"{BASE_URL}/v1/servers/{server_id}/qc",
                "-H", "Content-Type: application/json",
                "-H", f"X-API-Key: {api_key}",
                "-d", f"@{tmp}",
            ],
            capture_output=True, text=True, timeout=20,
        )
        lines = p.stdout.strip().rsplit("\n", 1)
        code = lines[-1] if len(lines) > 1 else "0"
        return code in ("200", "201")
    finally:
        os.unlink(tmp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Classify but do not PATCH")
    ap.add_argument("--limit", type=int, default=None,
                    help="Stop after this many servers (debug)")
    args = ap.parse_args()

    api_key = os.environ.get("TOOLIDX_API_KEY", "")
    if not args.dry_run and not api_key:
        print("ERROR: TOOLIDX_API_KEY required for --patch (or use --dry-run)",
              file=sys.stderr)
        sys.exit(1)

    counts = Counter()
    patched = 0
    skipped_pass = 0
    failed_patch = 0
    offset = 0
    seen = 0
    t0 = time.time()

    while True:
        page = fetch_page(offset)
        if not page:
            break

        for row in page:
            seen += 1
            if args.limit and seen > args.limit:
                break

            sid = row["id"]
            # List endpoint is slim — fetch the full record for qc_error
            full = fetch_full(sid)
            if not full:
                continue

            qc_error = full.get("qc_error")
            qc_status = full.get("qc_status")
            tool_count = full.get("tool_count")

            cls = classify_failure(
                qc_error,
                qc_status,
                hangs_on_start=bool(full.get("hangs_on_start")),
                requires_env_vars=bool(full.get("requires_env_vars")),
                external_deps_detected=full.get("external_deps_detected") or [],
                tool_count=tool_count,
            )

            if cls is None:
                skipped_pass += 1
                counts["__pass__"] += 1
                continue

            counts[cls] += 1

            if args.dry_run:
                continue

            # Re-PATCH with current qc_status + new failure_class
            payload = {
                "qc_status": qc_status,
                "failure_class": cls,
            }
            if _do_patch(sid, payload, api_key):
                patched += 1
            else:
                failed_patch += 1

        if args.limit and seen >= args.limit:
            break
        offset += PAGE_SIZE

    elapsed = time.time() - t0
    print("\n" + "=" * 60)
    print("BACKFILL SUMMARY" + (" (DRY RUN)" if args.dry_run else ""))
    print("=" * 60)
    print(f"  servers seen:        {seen}")
    print(f"  classified passes:   {skipped_pass}")
    print(f"  patched:             {patched}")
    print(f"  patch failures:      {failed_patch}")
    print(f"  elapsed:             {elapsed:.1f}s")
    print("\n  Distribution:")
    for cls, n in counts.most_common():
        print(f"    {cls:32s} {n:6d}")


if __name__ == "__main__":
    main()
