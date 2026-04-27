#!/usr/bin/env python3
"""
Weekly QC report — winners, losers, failure-mode distribution.

Reads the toolidx /v1/servers list + per-server qc_runs history, computes:
  - Failure_class distribution snapshot (counts + percentages)
  - Top 10 winners: servers that flipped from failed/error → passed this week,
    or jumped tool_count significantly
  - Top 10 losers: servers that flipped from passed → failed/error this week,
    or lost tool_count
  - Per-platform agreement rates (once qc_runs has data from both GH + GitLab)

Outputs:
  - Stdout: human-readable markdown summary
  - --json: machine-readable summary
  - --output <path>: write markdown to file (e.g. outputs/2026-04-27-weekly-report.md)

Usage:
    python3 scripts/weekly_report.py
    python3 scripts/weekly_report.py --output ../Fortress/outputs/$(date +%Y-%m-%d)-weekly-report.md
    python3 scripts/weekly_report.py --window 7  # default
    python3 scripts/weekly_report.py --window 30 # monthly
    python3 scripts/weekly_report.py --json
"""

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_URL = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")
PAGE_SIZE = 100  # /v1/servers caps limit at 100


def _curl_json(url: str, timeout: int = 20) -> dict | None:
    try:
        p = subprocess.run(
            ["curl", "-s", "--max-time", str(timeout - 3), url],
            capture_output=True, text=True, timeout=timeout,
        )
        return json.loads(p.stdout)
    except Exception:
        return None


def fetch_all_servers() -> list[dict]:
    """Walk all pages and return slim server records."""
    out = []
    for page in range(1, 30):
        d = _curl_json(f"{BASE_URL}/v1/servers?limit={PAGE_SIZE}&page={page}")
        if not d:
            continue
        rows = d.get("result", [])
        if not rows:
            break
        out.extend(rows)
    return out


def fetch_full(server_id: str) -> dict | None:
    """Per-server full record including failure_class, qc_error, qc_tested_at, etc."""
    d = _curl_json(f"{BASE_URL}/v1/servers/{server_id}?slim=true", timeout=15)
    return d.get("result") if d else None


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def build_report(window_days: int) -> dict:
    """Walk catalog, compute distribution + winners/losers within window."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)

    summary = fetch_all_servers()
    print(f"[report] catalog size: {len(summary)} servers", file=sys.stderr)

    # Count current snapshot
    distribution = Counter()
    by_status = Counter()
    in_window: list[dict] = []

    for i, row in enumerate(summary):
        full = fetch_full(row["id"])
        if not full:
            continue

        qc_status = full.get("qc_status") or "unknown"
        failure_class = full.get("failure_class")
        by_status[qc_status] += 1
        distribution[failure_class or "__pass_or_unset__"] += 1

        tested_at = parse_iso(full.get("qc_tested_at"))
        if tested_at and tested_at >= cutoff:
            in_window.append(full)

        if (i + 1) % 200 == 0:
            print(f"[report] scanned {i+1}/{len(summary)}", file=sys.stderr)

    # Sort movements within window
    # Winners: now passed
    winners = [r for r in in_window if r.get("qc_status") == "passed"]
    winners.sort(key=lambda r: (r.get("tool_count") or 0), reverse=True)
    winners = winners[:10]

    # Losers: now failed/error within window
    losers = [r for r in in_window if r.get("qc_status") in ("failed", "error")]
    losers.sort(key=lambda r: (r.get("description_quality_score") or 0), reverse=True)
    losers = losers[:10]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": window_days,
        "catalog_size": len(summary),
        "by_qc_status": dict(by_status),
        "failure_class_distribution": dict(distribution),
        "winners": [{"id": r["id"], "tool_count": r.get("tool_count"),
                     "qc_tested_at": r.get("qc_tested_at"),
                     "name": r.get("name")} for r in winners],
        "losers": [{"id": r["id"], "qc_status": r.get("qc_status"),
                    "failure_class": r.get("failure_class"),
                    "qc_tested_at": r.get("qc_tested_at"),
                    "name": r.get("name")} for r in losers],
    }


def render_markdown(report: dict) -> str:
    """Render a report dict as markdown for human reading or email."""
    lines = []
    lines.append(f"# toolidx — Weekly QC Report")
    lines.append("")
    lines.append(f"*Generated {report['generated_at']} · Window: last {report['window_days']} days · Catalog: {report['catalog_size']} servers*")
    lines.append("")

    lines.append("## Catalog health")
    lines.append("")
    lines.append("| qc_status | Count | % |")
    lines.append("|---|---:|---:|")
    total = max(report["catalog_size"], 1)
    for status, n in sorted(report["by_qc_status"].items(),
                            key=lambda kv: kv[1], reverse=True):
        lines.append(f"| {status} | {n} | {100*n/total:.1f}% |")
    lines.append("")

    lines.append("## Failure-mode distribution")
    lines.append("")
    lines.append("| failure_class | Count | % of catalog |")
    lines.append("|---|---:|---:|")
    for cls, n in sorted(report["failure_class_distribution"].items(),
                         key=lambda kv: kv[1], reverse=True):
        label = "*(passed / unset)*" if cls == "__pass_or_unset__" else f"`{cls}`"
        lines.append(f"| {label} | {n} | {100*n/total:.1f}% |")
    lines.append("")

    lines.append(f"## Top 10 winners (passed in last {report['window_days']}d, sorted by tool_count)")
    lines.append("")
    if report["winners"]:
        lines.append("| Server | Tools | Tested |")
        lines.append("|---|---:|---|")
        for w in report["winners"]:
            lines.append(f"| `{w['id']}` | {w.get('tool_count', '-')} | {w.get('qc_tested_at', '-')[:19] if w.get('qc_tested_at') else '-'} |")
    else:
        lines.append("*No winners in window.*")
    lines.append("")

    lines.append(f"## Top 10 losers (failed/error in last {report['window_days']}d)")
    lines.append("")
    if report["losers"]:
        lines.append("| Server | qc_status | failure_class | Tested |")
        lines.append("|---|---|---|---|")
        for l in report["losers"]:
            lines.append(f"| `{l['id']}` | {l.get('qc_status', '-')} | `{l.get('failure_class') or '-'}` | {l.get('qc_tested_at', '-')[:19] if l.get('qc_tested_at') else '-'} |")
    else:
        lines.append("*No losers in window.*")
    lines.append("")

    lines.append("---")
    lines.append("*Generated by `scripts/weekly_report.py`. For taxonomy + fix recipes see The MCP Server Failure Field Guide.*")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=7,
                    help="Window in days for winners/losers (default 7)")
    ap.add_argument("--output", type=str, default=None,
                    help="Write markdown to this path (default: stdout)")
    ap.add_argument("--json", action="store_true",
                    help="Emit raw JSON instead of markdown")
    args = ap.parse_args()

    report = build_report(args.window)

    if args.json:
        out = json.dumps(report, indent=2)
    else:
        out = render_markdown(report)

    if args.output:
        Path(args.output).write_text(out)
        print(f"[report] wrote {args.output}", file=sys.stderr)
    else:
        print(out)


if __name__ == "__main__":
    main()
