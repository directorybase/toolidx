#!/usr/bin/env python3
"""
Single-server QC test — installs an MCP server and introspects it via the MCP protocol.

Usage:
    python3 scripts/qc-test-single.py [options]

Options:
    --install-cmd "npx -y @pkg"   Install command (default: filesystem server)
    --server-id id                toolidx server ID to PATCH results to
    --patch                       PATCH result back to toolidx (requires TOOLIDX_API_KEY)
    --quiet                       Suppress verbose protocol output

Environment:
    TOOLIDX_API_KEY   Required for --patch
    TOOLIDX_BASE      Base URL (default: https://toolidx.dev)
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

DEFAULT_INSTALL_CMD = "npx -y @modelcontextprotocol/server-filesystem /tmp"
DEFAULT_SERVER_ID = "github-com-modelcontextprotocol-servers"

INIT_MSG = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "toolidx-qc", "version": "0.2.0"},
    },
}

INITIALIZED_NOTIF = {
    "jsonrpc": "2.0",
    "method": "notifications/initialized",
}


def msg(method: str, id: int, params: dict = None) -> dict:
    m = {"jsonrpc": "2.0", "id": id, "method": method}
    if params is not None:
        m["params"] = params
    return m


def send(proc, payload: dict):
    proc.stdin.write((json.dumps(payload) + "\n").encode())
    proc.stdin.flush()


def recv(proc, expected_id: int = None, timeout: float = 15.0) -> dict | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return None  # process died
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
            # Skip notifications — they have method but no id
            if "method" in parsed and "id" not in parsed:
                continue
            # Skip responses with wrong id
            if expected_id is not None and parsed.get("id") != expected_id:
                continue
            return parsed
        except json.JSONDecodeError:
            continue
    raise TimeoutError(f"No JSON-RPC response within {timeout}s")


EXTERNAL_DEP_PATTERNS = [
    "ffmpeg", "ffprobe", "git", "docker", "sqlite3", "pandoc", "curl",
    "wget", "openssl", "imagemagick", "convert", "ghostscript", "gs",
    "chromium", "chrome", "playwright", "xvfb",
]

def analyze_annotations(tools: list) -> tuple[bool, bool]:
    """Returns (has_destructive, all_readonly)."""
    has_destructive = False
    all_readonly = bool(tools)
    for t in tools:
        ann = t.get("annotations", {})
        if ann.get("destructiveHint"):
            has_destructive = True
        if not ann.get("readOnlyHint"):
            all_readonly = False
    return has_destructive, all_readonly


def score_description_quality(tools: list) -> float:
    """Heuristic 0-10: rewards long, descriptive tool descriptions."""
    if not tools:
        return 0.0
    scores = []
    for t in tools:
        desc = t.get("description", "")
        length_score = min(len(desc) / 100, 1.0)  # 100 chars = full score
        has_verb = any(w in desc.lower() for w in ["get", "fetch", "create", "update", "delete",
                                                    "search", "list", "send", "read", "write",
                                                    "returns", "retrieves", "creates", "enables"])
        scores.append(length_score * 8 + (2 if has_verb else 0))
    return round(sum(scores) / len(scores), 2)


def detect_external_deps(stderr: str) -> list[str]:
    """Detect missing external binary dependencies from stderr."""
    found = []
    low = stderr.lower()
    for dep in EXTERNAL_DEP_PATTERNS:
        if dep in low:
            found.append(dep)
    return found


def compute_setup_complexity(requires_env_vars: bool, external_deps: list) -> str:
    score = 0
    if requires_env_vars:
        score += 2
    score += len(external_deps)
    if score == 0:
        return "low"
    elif score <= 2:
        return "medium"
    return "high"


def stderr_suggests_env_vars(stderr: str) -> bool:
    keywords = ["api key", "token", "secret", "credential", "missing", "required",
                 "env", "environment", "unauthorized", "authentication", "ENOENT"]
    low = stderr.lower()
    return any(k.lower() in low for k in keywords)


def run_qc(install_cmd: str, server_id: str, verbose: bool = True) -> dict:
    result = {
        "server_id": server_id,
        "install_cmd": install_cmd,
        "qc_status": "error",
        "qc_error": None,
        "tool_count": 0,
        "tool_schemas": [],
        "server_version": None,
        "protocol_version": None,
        "capabilities": None,
        "server_instructions": None,
        "resources_list": None,
        "prompts_list": None,
        "has_destructive_tools": False,
        "all_tools_readonly": False,
        "install_duration_ms": None,
        "requires_env_vars": False,
        "description_quality_score": None,
        "external_deps_detected": [],
        "setup_complexity": "low",
    }

    cmd_parts = install_cmd.split()
    print(f"\n[QC] Starting: {install_cmd}")

    t_start = time.time()
    try:
        proc = subprocess.Popen(
            cmd_parts,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as e:
        result["qc_error"] = f"Command not found: {e}"
        return result

    try:
        # ── 1. Initialize ────────────────────────────────────────────────────
        send(proc, INIT_MSG)
        init_resp = recv(proc, expected_id=1, timeout=30)

        if init_resp is None:
            # Process died before responding
            stderr = proc.stderr.read().decode(errors="replace")
            result["requires_env_vars"] = stderr_suggests_env_vars(stderr)
            result["external_deps_detected"] = detect_external_deps(stderr)
            result["setup_complexity"] = compute_setup_complexity(result["requires_env_vars"], result["external_deps_detected"])
            result["qc_error"] = f"Process exited before initialize. stderr: {stderr[:300]}"
            result["qc_status"] = "failed"
            return result

        result["install_duration_ms"] = int((time.time() - t_start) * 1000)

        if verbose:
            print(f"[QC] initialize: {json.dumps(init_resp, indent=2)}")

        if "error" in init_resp:
            result["qc_error"] = f"initialize error: {init_resp['error']}"
            return result

        init_result = init_resp.get("result", {})
        result["protocol_version"] = init_result.get("protocolVersion")
        result["server_version"] = init_result.get("serverInfo", {}).get("version")
        result["server_instructions"] = init_result.get("instructions")
        caps = init_result.get("capabilities", {})
        result["capabilities"] = caps

        send(proc, INITIALIZED_NOTIF)

        # ── 2. Tools list ────────────────────────────────────────────────────
        send(proc, msg("tools/list", 2, {}))
        tools_resp = recv(proc, expected_id=2, timeout=15)

        if verbose:
            print(f"\n[QC] tools/list: {json.dumps(tools_resp, indent=2)}")

        if tools_resp and "error" not in tools_resp:
            tools = tools_resp.get("result", {}).get("tools", [])
            result["tool_schemas"] = tools
            result["tool_count"] = len(tools)
            has_dest, all_ro = analyze_annotations(tools)
            result["has_destructive_tools"] = has_dest
            result["all_tools_readonly"] = all_ro
            result["description_quality_score"] = score_description_quality(tools)

            print(f"\n[QC] {len(tools)} tools found:")
            for t in tools:
                ann = t.get("annotations", {})
                flags = []
                if ann.get("readOnlyHint"):
                    flags.append("readonly")
                if ann.get("destructiveHint"):
                    flags.append("DESTRUCTIVE")
                flag_str = f" [{', '.join(flags)}]" if flags else ""
                print(f"  • {t['name']}{flag_str}: {t.get('description','')[:80]}")

        # ── 3. Resources list (if supported) ─────────────────────────────────
        if "resources" in caps:
            send(proc, msg("resources/list", 3, {}))
            res_resp = recv(proc, expected_id=3, timeout=10)
            if verbose:
                print(f"\n[QC] resources/list: {json.dumps(res_resp, indent=2)}")
            if res_resp and "error" not in res_resp:
                result["resources_list"] = res_resp.get("result", {}).get("resources", [])
                print(f"[QC] {len(result['resources_list'])} resources found")

        # ── 4. Prompts list (if supported) ───────────────────────────────────
        if "prompts" in caps:
            send(proc, msg("prompts/list", 4, {}))
            pmt_resp = recv(proc, expected_id=4, timeout=10)
            if verbose:
                print(f"\n[QC] prompts/list: {json.dumps(pmt_resp, indent=2)}")
            if pmt_resp and "error" not in pmt_resp:
                result["prompts_list"] = pmt_resp.get("result", {}).get("prompts", [])
                print(f"[QC] {len(result['prompts_list'])} prompts found")

        stderr = proc.stderr.read().decode(errors="replace") if proc.poll() is not None else ""
        result["external_deps_detected"] = detect_external_deps(stderr)
        result["setup_complexity"] = compute_setup_complexity(result["requires_env_vars"], result["external_deps_detected"])
        result["qc_status"] = "passed"

    except TimeoutError as e:
        result["qc_error"] = str(e)
        result["qc_status"] = "error"
        print(f"[QC] TIMEOUT: {e}")
    except Exception as e:
        result["qc_error"] = str(e)
        result["qc_status"] = "error"
        print(f"[QC] ERROR: {e}")
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    return result


def patch_toolidx(result: dict, base_url: str, api_key: str) -> bool:
    server_id = result["server_id"]
    payload = {
        "qc_status": result["qc_status"],
        "tool_schemas": result["tool_schemas"] or [],
        "server_version": result["server_version"],
        "protocol_version": result["protocol_version"],
        "capabilities": result["capabilities"],
        "server_instructions": result["server_instructions"],
        "resources_list": result["resources_list"],
        "prompts_list": result["prompts_list"],
        "has_destructive_tools": result["has_destructive_tools"],
        "all_tools_readonly": result["all_tools_readonly"],
        "install_duration_ms": result["install_duration_ms"],
        "requires_env_vars": result["requires_env_vars"],
        "description_quality_score": result["description_quality_score"],
        "external_deps_detected": result["external_deps_detected"],
        "setup_complexity": result["setup_complexity"],
    }
    if result["qc_error"]:
        payload["qc_error"] = result["qc_error"]

    print(f"\n[PATCH] Sending QC result for {server_id} to {base_url}...")
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        tmp_path = f.name
    try:
        proc = subprocess.run(
            [
                "curl", "-s", "-X", "PATCH",
                f"{base_url}/v1/servers/{server_id}/qc",
                "-H", "Content-Type: application/json",
                "-H", f"X-API-Key: {api_key}",
                "-d", f"@{tmp_path}",
            ],
            capture_output=True, text=True, timeout=15,
        )
        resp = json.loads(proc.stdout)
        print(f"[PATCH] Response: {resp}")
        return resp.get("success", False)
    except Exception as e:
        print(f"[PATCH] Failed: {e}\n{proc.stdout}")
        return False
    finally:
        os.unlink(tmp_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--install-cmd", default=DEFAULT_INSTALL_CMD)
    parser.add_argument("--server-id", default=DEFAULT_SERVER_ID)
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--patch", action="store_true", help="PATCH result back to toolidx")
    args = parser.parse_args()

    result = run_qc(args.install_cmd, args.server_id, verbose=not args.quiet)

    print("\n" + "=" * 60)
    print("QC RESULT SUMMARY")
    print("=" * 60)
    print(f"  server_id:          {result['server_id']}")
    print(f"  qc_status:          {result['qc_status']}")
    print(f"  tool_count:         {result['tool_count']}")
    print(f"  server_version:     {result['server_version']}")
    print(f"  protocol_version:   {result['protocol_version']}")
    print(f"  install_duration:   {result['install_duration_ms']}ms")
    print(f"  has_destructive:    {result['has_destructive_tools']}")
    print(f"  all_readonly:       {result['all_tools_readonly']}")
    print(f"  requires_env_vars:  {result['requires_env_vars']}")
    caps = result["capabilities"] or {}
    print(f"  capabilities:       {', '.join(caps.keys()) or 'none'}")
    if result["server_instructions"]:
        print(f"  instructions:       {result['server_instructions'][:80]}...")
    if result["resources_list"] is not None:
        print(f"  resources:          {len(result['resources_list'])}")
    if result["prompts_list"] is not None:
        print(f"  prompts:            {len(result['prompts_list'])}")
    if result["qc_error"]:
        print(f"  qc_error:           {result['qc_error']}")

    if args.patch:
        api_key = os.environ.get("TOOLIDX_API_KEY", "")
        base_url = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")
        if not api_key:
            print("\n[PATCH] Skipped — TOOLIDX_API_KEY not set")
        else:
            patch_toolidx(result, base_url, api_key)


if __name__ == "__main__":
    main()
