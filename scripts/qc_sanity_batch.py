#!/usr/bin/env python3
"""
QC sanity batch — runs QC on a fixed list of servers and writes a comparison report.

Used by both GitHub Actions and GitLab CI to verify platform parity.
Results are PATCHed to toolidx and written to qc_sanity_report.json.

Usage:
    python3 scripts/qc_sanity_batch.py --platform github --servers id1 id2 ...
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from multiprocessing import Process, Queue

sys.path.insert(0, os.path.dirname(__file__))
from qc_test_single import run_qc

PER_SERVER_TIMEOUT = 180  # 3 minutes hard kill per server


def _qc_worker(install_cmd: str, server_id: str, result_q: Queue):
    try:
        result = run_qc(install_cmd, server_id, verbose=False)
        result_q.put(result)
    except Exception as e:
        result_q.put({"server_id": server_id, "qc_status": "error", "qc_error": str(e),
                      "tool_count": 0, "tool_schemas": [], "server_version": None,
                      "protocol_version": None, "capabilities": None,
                      "server_instructions": None, "resources_list": None,
                      "prompts_list": None, "has_destructive_tools": False,
                      "all_tools_readonly": False, "install_duration_ms": None,
                      "requires_env_vars": False, "description_quality_score": None,
                      "external_deps_detected": [], "setup_complexity": "low",
                      "install_cmd": install_cmd})


def run_qc_with_timeout(install_cmd: str, server_id: str) -> dict:
    timeout_result = {
        "server_id": server_id, "install_cmd": install_cmd,
        "qc_status": "error", "qc_error": f"Hard timeout after {PER_SERVER_TIMEOUT}s",
        "tool_count": 0, "tool_schemas": [], "server_version": None,
        "protocol_version": None, "capabilities": None, "server_instructions": None,
        "resources_list": None, "prompts_list": None, "has_destructive_tools": False,
        "all_tools_readonly": False, "install_duration_ms": None,
        "requires_env_vars": False, "description_quality_score": None,
        "external_deps_detected": [], "setup_complexity": "low",
    }
    result_q: Queue = Queue()
    p = Process(target=_qc_worker, args=(install_cmd, server_id, result_q), daemon=True)
    p.start()
    p.join(timeout=PER_SERVER_TIMEOUT)
    if p.is_alive():
        print(f"  [timeout] {server_id} — killing after {PER_SERVER_TIMEOUT}s", flush=True)
        p.kill()
        p.join(timeout=5)
        return timeout_result
    return result_q.get() if not result_q.empty() else timeout_result

TOOLIDX_API_KEY = os.environ.get("TOOLIDX_API_KEY", "")
TOOLIDX_BASE = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")


def fetch_server(server_id: str) -> dict | None:
    proc = subprocess.run(
        ["curl", "-s", "--max-time", "15", f"{TOOLIDX_BASE}/v1/servers/{server_id}"],
        capture_output=True, text=True, timeout=20,
    )
    try:
        data = json.loads(proc.stdout)
        return data.get("result") or data
    except Exception:
        return None


def patch_qc_result(result: dict, platform: str) -> bool:
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
        "hangs_on_start": result.get("hangs_on_start", False),
        "tools_list_duration_ms": result.get("tools_list_duration_ms"),
        "qc_platform": result.get("qc_platform", "local"),
    }
    if result.get("qc_error"):
        payload["qc_error"] = result["qc_error"]
    payload = {k: v for k, v in payload.items() if v is not None}

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


def summary_row(result: dict) -> dict:
    """Extract the fields relevant for cross-platform comparison."""
    return {
        "server_id": result["server_id"],
        "qc_status": result["qc_status"],
        "tool_count": result.get("tool_count", 0),
        "protocol_version": result.get("protocol_version"),
        "server_version": result.get("server_version"),
        "has_destructive_tools": result.get("has_destructive_tools", False),
        "all_tools_readonly": result.get("all_tools_readonly", False),
        "requires_env_vars": result.get("requires_env_vars", False),
        "setup_complexity": result.get("setup_complexity"),
        "description_quality_score": result.get("description_quality_score"),
        "install_duration_ms": result.get("install_duration_ms"),
        "qc_error": result.get("qc_error"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", required=True, choices=["github", "gitlab", "local"])
    parser.add_argument("--servers", nargs="+", required=True)
    args = parser.parse_args()

    if not TOOLIDX_API_KEY:
        sys.exit("Error: TOOLIDX_API_KEY required")

    print(f"\n[sanity] Platform: {args.platform} | {len(args.servers)} servers | {TOOLIDX_BASE}")
    print("=" * 60)

    report = {
        "platform": args.platform,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "servers": [],
    }

    passed = failed = error = 0

    for server_id in args.servers:
        server = fetch_server(server_id)
        if not server:
            print(f"  ✗ {server_id} — could not fetch from API")
            error += 1
            continue

        install_cmd = server.get("install_command")
        if not install_cmd:
            print(f"  ✗ {server_id} — no install_command")
            error += 1
            continue

        result = run_qc_with_timeout(install_cmd, server_id)
        ok = patch_qc_result(result, args.platform)

        status = result["qc_status"]
        tools = result.get("tool_count", 0)
        q = result.get("description_quality_score")
        q_str = f" quality={q:.1f}" if q else ""
        patch_tick = "✓" if ok else "✗"
        print(f"  [{status}] {server_id} — {tools} tools{q_str} (patch:{patch_tick})")

        if status == "passed":
            passed += 1
        elif status == "failed":
            failed += 1
        else:
            error += 1

        report["servers"].append(summary_row(result))

    report["summary"] = {"passed": passed, "failed": failed, "error": error}

    report_path = "qc_sanity_report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    print("\n" + "=" * 60)
    print(f"[sanity] Done — passed={passed} failed={failed} error={error}")
    print(f"[sanity] Report written to {report_path}")

    # Print comparison table
    print("\nSERVER                                          STATUS   TOOLS  QUALITY")
    print("-" * 72)
    for row in report["servers"]:
        sid = row["server_id"][:46].ljust(46)
        st = row["qc_status"].ljust(8)
        tc = str(row["tool_count"]).rjust(5)
        q = f"{row['description_quality_score']:.1f}" if row["description_quality_score"] else "  —  "
        print(f"  {sid} {st} {tc}  {q}")


if __name__ == "__main__":
    main()
