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
import hashlib
import json
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

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
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        ready, _, _ = select.select([proc.stdout], [], [], min(remaining, 1.0))
        if not ready:
            continue
        line = proc.stdout.readline()
        if not line:
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


# ── Platform detection ────────────────────────────────────────────────────────

def detect_platform() -> str:
    """Detect CI platform from environment variables.

    Checks GITHUB_ACTIONS, GITLAB_CI, CIRRUS_CI in order.
    Returns 'unknown' if none match.
    """
    if os.environ.get("GITHUB_ACTIONS") == "true":
        return "github"
    if os.environ.get("GITLAB_CI") == "true":
        return "gitlab"
    if os.environ.get("CIRRUS_CI") == "true":
        return "cirrus"
    return "unknown"


# ── Auth detection ────────────────────────────────────────────────────────────

_AUTH_PATTERN = re.compile(
    r"unauthorized|forbidden|authentication required|invalid api key|"
    r"bad credentials|401|403|missing token",
    re.IGNORECASE,
)

_AUTH_SCHEMA_PROPS = re.compile(
    r"^(api_key|apikey|auth_token|bearer|credentials|access_token|secret)$",
    re.IGNORECASE,
)

_AUTH_ENV_PATTERN = re.compile(r"(_TOKEN|_API_KEY|_SECRET|^OAUTH_)", re.IGNORECASE)


def is_auth_error(text: str) -> bool:
    """Return True if text contains auth-related error signals (spec rule #1)."""
    return bool(_AUTH_PATTERN.search(text))


def schema_requires_auth(tool_schema: dict) -> bool:
    """Return True if the tool schema declares auth-related required properties (spec rule #2)."""
    inner = tool_schema.get("inputSchema", tool_schema)
    required = inner.get("required", [])
    for r in required:
        if _AUTH_SCHEMA_PROPS.match(r):
            return True
    return False


# ── Destructive tool detection ─────────────────────────────────────────────────

# Matches spec list: delete_ | drop_ | remove_ | truncate_ | exec_ | write_ | execute_ | run_ | terminate_
# Uses (_|$) so "runner_status" does NOT match but "run_script" and "run" (bare) do.
_DESTRUCTIVE_PATTERN = re.compile(
    r"^(delete|drop|remove|truncate|exec|write|execute|run|terminate)(_|$)",
    re.IGNORECASE,
)


def is_destructive_tool(tool: dict) -> bool:
    """Return True if the tool should be skipped as potentially destructive."""
    name = tool.get("name", "")
    if _DESTRUCTIVE_PATTERN.match(name):
        return True
    ann = tool.get("annotations", {})
    if ann.get("destructiveHint") or ann.get("x-destructive"):
        return True
    schema = tool.get("inputSchema", {})
    if schema.get("x-destructive"):
        return True
    return False


# ── Schema hashing ────────────────────────────────────────────────────────────

def schema_hash(tool: dict) -> str:
    """Stable SHA-256 hash of a tool's inputSchema (first 16 hex chars)."""
    schema = tool.get("inputSchema", {})
    canonical = json.dumps(schema, sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


# ── Naive arg generation ──────────────────────────────────────────────────────

_FORMAT_DEFAULTS = {
    "uri": "https://example.com",
    "email": "test@example.com",
    "uuid": "00000000-0000-0000-0000-000000000000",
    "date-time": "2026-01-01T00:00:00Z",
}


def generate_naive_args(schema: dict) -> dict:
    """
    Generate naive test arguments from a JSON Schema (inputSchema).
    Only populates required fields; recurses into nested objects.
    Spec: Naive fallback rules.
    """
    props = schema.get("properties", {})
    required = set(schema.get("required", []))
    args = {}
    for name, defn in props.items():
        if name not in required:
            continue
        args[name] = _naive_value(defn)
    return args


def _naive_value(defn: dict):
    """Return a naive test value for a single schema property definition."""
    if "enum" in defn and defn["enum"]:
        return defn["enum"][0]
    typ = defn.get("type", "string")
    fmt = defn.get("format", "")
    if typ == "string":
        return _FORMAT_DEFAULTS.get(fmt, "test")
    if typ in ("integer", "number"):
        return 0
    if typ == "boolean":
        return False
    if typ == "array":
        return []
    if typ == "object":
        return generate_naive_args(defn)
    return None


# ── Fetch cached test args ────────────────────────────────────────────────────

def fetch_cached_args(sh: str, base_url: str) -> dict | None:
    """Fetch cached test args from toolidx API. Returns None if not found or on error."""
    try:
        p = subprocess.run(
            ["curl", "-s", f"{base_url}/v1/tools/test_args/{sh}"],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(p.stdout)
        if "args" in data:
            return json.loads(data["args"])
        return None
    except Exception:
        return None


# ── Tool invocation ───────────────────────────────────────────────────────────

def invoke_tool(mcp_proc, tool_name: str, args: dict, msg_id: int) -> tuple[str | None, float, str | None]:
    """
    Call a tool via MCP tools/call with 10s timeout.
    Returns (raw_text, latency_ms, error_text).
    """
    t0 = time.time()
    call_msg = msg("tools/call", msg_id, {"name": tool_name, "arguments": args})
    send(mcp_proc, call_msg)
    try:
        resp = recv(mcp_proc, expected_id=msg_id, timeout=10)
        latency_ms = (time.time() - t0) * 1000
        if resp is None:
            return None, latency_ms, "no response"
        if "error" in resp:
            return None, latency_ms, json.dumps(resp["error"])[:500]
        content = resp.get("result", {}).get("content", [])
        return json.dumps(content), latency_ms, None
    except TimeoutError:
        latency_ms = (time.time() - t0) * 1000
        return None, latency_ms, "timeout"


def classify_tool_result(
    raw_text: str | None,
    error_text: str | None,
    tool: dict,
    required_env_vars: list[str] | None = None,
) -> tuple[str, str | None, str | None]:
    """
    Classify a tool invocation result per the spec status taxonomy.
    Returns (status, error_class, error_sample).
    """
    if error_text == "timeout":
        return "timeout", "timeout", None

    combined = (raw_text or "") + (error_text or "")

    # Rule #1: response text contains auth signals
    if is_auth_error(combined):
        return "needs-auth", "auth", (error_text or "")[:500]

    # Rule #2: schema declares auth params
    if schema_requires_auth(tool):
        return "needs-auth", "auth", "schema requires auth parameter"

    # Rule #3: server env hints
    for ev in (required_env_vars or []):
        if _AUTH_ENV_PATTERN.search(ev):
            return "needs-auth", "auth", f"server env: {ev}"

    if error_text:
        low = error_text.lower()
        if "crash" in low or "sigabrt" in low:
            ec = "crash"
        elif "schema" in low or "invalid" in low:
            ec = "schema_mismatch"
        elif "500" in error_text or "server error" in low:
            ec = "server_error"
        else:
            ec = "tool_error"
        return "broken", ec, error_text[:500]

    return "working", None, None


# ── Per-tool test loop ────────────────────────────────────────────────────────

def test_all_tools(
    mcp_proc,
    tools: list,
    server_id: str,
    base_url: str,
    required_env_vars: list[str] | None = None,
    verbose: bool = True,
) -> list[dict]:
    """
    Invoke each declared tool, classify, and return qc_tool_results list.
    Spec: Test invocation strategy.
    """
    results = []
    msg_id_start = 100  # avoid collisions with protocol setup ids (1-4)

    for i, tool in enumerate(tools):
        name = tool.get("name", f"tool_{i}")
        tool_schema = tool.get("inputSchema", {})
        tested_at = datetime.now(timezone.utc).isoformat()

        # ── Destructive skip ──────────────────────────────────────────────────
        if is_destructive_tool(tool):
            print(f"  [SKIP] {name} — destructive", flush=True)
            results.append({
                "tool_name": name,
                "status": "not-tested",
                "not_tested_reason": "destructive",
                "latency_ms": None,
                "error_class": None,
                "error_sample": None,
                "sample_args": None,
                "tested_at": tested_at,
            })
            continue

        # ── Fetch or generate args ────────────────────────────────────────────
        sh = schema_hash(tool)
        args = fetch_cached_args(sh, base_url)
        if args is None:
            args = generate_naive_args(tool_schema)

        if verbose:
            print(f"  [TEST] {name} args={json.dumps(args)[:120]}", flush=True)

        # ── Invoke ────────────────────────────────────────────────────────────
        mid = msg_id_start + i
        raw_text, latency_ms, error_text = invoke_tool(mcp_proc, name, args, mid)

        # ── Classify ──────────────────────────────────────────────────────────
        status, error_class, error_sample = classify_tool_result(
            raw_text, error_text, tool, required_env_vars
        )

        print(f"  [{status.upper()}] {name} ({latency_ms:.0f}ms)", flush=True)

        results.append({
            "tool_name": name,
            "status": status,
            "latency_ms": int(latency_ms),
            "error_class": error_class,
            "error_sample": error_sample,
            "sample_args": json.dumps(args),
            "tested_at": tested_at,
        })

    return results


# ── Artifact write ────────────────────────────────────────────────────────────

def write_artifact(result: dict, run_id: str) -> str:
    """Write QC run results to a local JSON artifact file for the Gitea archive agent."""
    artifact_dir = os.path.join(os.path.dirname(__file__), "..", "qc-artifacts")
    os.makedirs(artifact_dir, exist_ok=True)
    fname = os.path.join(artifact_dir, f"{result['server_id']}_{run_id}.json")
    with open(fname, "w") as f:
        json.dump(result, f, indent=2)
    print(f"[ARTIFACT] Written to {fname}", flush=True)
    return fname


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
        "hangs_on_start": False,
        "tools_list_duration_ms": None,
        "qc_platform": detect_platform(),
        "schema_weight_chars": None,
        "qc_tool_results": [],
    }

    cmd_parts = install_cmd.split()
    print(f"\n[QC] Starting: {install_cmd}", flush=True)

    t_start = time.time()
    stderr_file = tempfile.NamedTemporaryFile(mode="wb", delete=False)
    try:
        proc = subprocess.Popen(
            cmd_parts,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
            start_new_session=True,
        )
        stderr_file.close()
    except FileNotFoundError as e:
        stderr_file.close()
        os.unlink(stderr_file.name)
        result["qc_error"] = f"Command not found: {e}"
        return result

    try:
        # ── 1. Initialize ────────────────────────────────────────────────────
        send(proc, INIT_MSG)
        init_resp = recv(proc, expected_id=1, timeout=120)

        if init_resp is None:
            try:
                with open(stderr_file.name, "rb") as f:
                    stderr = f.read().decode(errors="replace")
            except Exception:
                stderr = ""
            result["requires_env_vars"] = stderr_suggests_env_vars(stderr)
            result["external_deps_detected"] = detect_external_deps(stderr)
            result["setup_complexity"] = compute_setup_complexity(
                result["requires_env_vars"], result["external_deps_detected"]
            )
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
        t_tools_start = time.time()
        send(proc, msg("tools/list", 2, {}))
        tools_resp = recv(proc, expected_id=2, timeout=15)
        result["tools_list_duration_ms"] = int((time.time() - t_tools_start) * 1000)

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
            result["schema_weight_chars"] = sum(len(json.dumps(t)) for t in tools)

            print(f"\n[QC] {len(tools)} tools found:")
            for t in tools:
                ann = t.get("annotations", {})
                flags = []
                if ann.get("readOnlyHint"):
                    flags.append("readonly")
                if ann.get("destructiveHint"):
                    flags.append("DESTRUCTIVE")
                flag_str = f" [{', '.join(flags)}]" if flags else ""
                print(f"  \u2022 {t['name']}{flag_str}: {t.get('description','')[:80]}")

            # ── 2b. Per-tool invocation ───────────────────────────────────────
            base_url = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")
            print(f"\n[QC] Running per-tool tests...", flush=True)
            result["qc_tool_results"] = test_all_tools(
                mcp_proc=proc,
                tools=tools,
                server_id=server_id,
                base_url=base_url,
                required_env_vars=None,
                verbose=verbose,
            )

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

        result["external_deps_detected"] = []
        result["setup_complexity"] = compute_setup_complexity(
            result["requires_env_vars"], result["external_deps_detected"]
        )
        result["qc_status"] = "passed"

    except TimeoutError as e:
        result["qc_error"] = str(e)
        result["qc_status"] = "error"
        result["hangs_on_start"] = result["install_duration_ms"] is None
        print(f"[QC] TIMEOUT: {e}", flush=True)
    except Exception as e:
        result["qc_error"] = str(e)
        result["qc_status"] = "error"
        print(f"[QC] ERROR: {e}", flush=True)
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass
        try:
            with open(stderr_file.name, "rb") as f:
                stderr = f.read().decode(errors="replace")
        except Exception:
            stderr = ""
        finally:
            try:
                os.unlink(stderr_file.name)
            except Exception:
                pass
        if result["qc_status"] in ("error", "failed") or not result["external_deps_detected"]:
            result["external_deps_detected"] = detect_external_deps(stderr)
            result["setup_complexity"] = compute_setup_complexity(
                result["requires_env_vars"], result["external_deps_detected"]
            )

    return result


def patch_toolidx(result: dict, base_url: str, api_key: str) -> bool:
    """
    PATCH QC results to toolidx API.

    Tries /v1/servers/{id}/qc_run first; if 404 falls back to /v1/servers/{id}/qc.
    If both endpoints fail, writes a local JSON artifact for the Gitea archive agent.
    """
    server_id = result["server_id"]
    run_id = hashlib.sha256(f"{server_id}{time.time()}".encode()).hexdigest()[:12]

    payload = {
        "run_id": run_id,
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
        "hangs_on_start": result.get("hangs_on_start", False),
        "tools_list_duration_ms": result.get("tools_list_duration_ms"),
        "qc_platform": result.get("qc_platform", "unknown"),
        "schema_weight_chars": result.get("schema_weight_chars"),
        "qc_tool_results": result.get("qc_tool_results", []),
        "failure_class": result.get("failure_class"),
    }
    if result.get("qc_error"):
        payload["qc_error"] = result["qc_error"]

    print(f"\n[PATCH] Sending QC result for {server_id} to {base_url}...")
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        tmp_path = f.name

    proc = None
    try:
        success = False
        for endpoint in (f"/v1/servers/{server_id}/qc_run", f"/v1/servers/{server_id}/qc"):
            proc = subprocess.run(
                [
                    "curl", "-s", "-w", "\n%{http_code}",
                    "-X", "PATCH",
                    f"{base_url}{endpoint}",
                    "-H", "Content-Type: application/json",
                    "-H", f"X-API-Key: {api_key}",
                    "-d", f"@{tmp_path}",
                ],
                capture_output=True, text=True, timeout=15,
            )
            lines = proc.stdout.strip().rsplit("\n", 1)
            body = lines[0] if len(lines) > 1 else proc.stdout
            http_code = lines[-1].strip() if len(lines) > 1 else "0"
            if http_code in ("200", "201"):
                try:
                    resp = json.loads(body)
                    print(f"[PATCH] Response ({endpoint}): {resp}")
                    success = resp.get("success", True)
                except Exception:
                    success = True
                break
            elif http_code == "404" and endpoint.endswith("/qc_run"):
                print(f"[PATCH] /qc_run endpoint not found, trying /qc...", flush=True)
                continue
            else:
                print(f"[PATCH] Unexpected HTTP {http_code} from {endpoint}: {body[:200]}")
        else:
            # All endpoints failed — write artifact for Gitea archive agent
            artifact_result = dict(result)
            artifact_result["run_id"] = run_id
            write_artifact(artifact_result, run_id)
            return False
        return success
    except Exception as e:
        stdout = proc.stdout if proc is not None else ""
        print(f"[PATCH] Failed: {e}\n{stdout}")
        artifact_result = dict(result)
        artifact_result["run_id"] = run_id
        write_artifact(artifact_result, run_id)
        return False
    finally:
        os.unlink(tmp_path)



def archive_to_gitea(result: dict, run_id: str, base_url: str, api_key: str) -> bool:
    """
    POST the completed QC run to POST /internal/qc-archive on the toolidx Worker.
    The Worker commits the run as an immutable JSON file to agenticwatch-results on Gitea.

    Archive path: qc-runs/YYYY-MM-DD/{server_id}_{run_id}.json
    Commit message: qc: {server_id} on {platform} at {started_at}

    The Gitea token lives in the Worker secret GITEA_TOKEN.
    CI only needs TOOLIDX_API_KEY — the token never touches CI runners.
    Idempotent: never overwrites a file that already exists (run_id is globally unique).
    """
    started_at = result.get("started_at") or datetime.now(timezone.utc).isoformat()
    payload: dict = {
        "run_id": run_id,
        "server_id": result["server_id"],
        "platform": result.get("qc_platform", "local"),
        "status": result["qc_status"] if result["qc_status"] in ("passed", "failed", "error") else "error",
        "started_at": started_at,
        "tool_results": result.get("qc_tool_results", []),
        "tool_schemas": result.get("tool_schemas", []),
    }
    for field in ("runner_os", "runner_arch", "runner_runtime_version", "finished_at"):
        if result.get(field):
            payload[field] = result[field]
    for field in ("install_duration_ms", "tools_list_duration_ms"):
        if result.get(field) is not None:
            payload[field] = result[field]
    tool_count = len(result.get("qc_tool_results", []))
    if tool_count:
        payload["tools_tested_count"] = tool_count
    if result.get("qc_error"):
        payload["error_class"] = result.get("error_class") or "qc_error"

    print(f"\n[ARCHIVE] Archiving run {run_id} to Gitea via {base_url}/internal/qc-archive ...", flush=True)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        tmp_path = f.name
    proc = None
    try:
        proc = subprocess.run(
            [
                "curl", "-s", "-X", "POST",
                f"{base_url}/internal/qc-archive",
                "-H", "Content-Type: application/json",
                "-H", f"X-API-Key: {api_key}",
                "-d", f"@{tmp_path}",
            ],
            capture_output=True, text=True, timeout=30,
        )
        resp = json.loads(proc.stdout)
        r = resp.get("result", {})
        already = r.get("already_existed", False)
        path = r.get("path", "?")
        if resp.get("success"):
            tag = "already archived" if already else "committed"
            print(f"[ARCHIVE] OK — {tag} at {path}", flush=True)
        else:
            print(f"[ARCHIVE] Failed: {resp}", flush=True)
        return resp.get("success", False)
    except Exception as e:
        stdout = proc.stdout if proc is not None else ""
        print(f"[ARCHIVE] Error: {e}\n{stdout}", flush=True)
        return False
    finally:
        os.unlink(tmp_path)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--install-cmd", default=DEFAULT_INSTALL_CMD)
    parser.add_argument("--server-id", default=DEFAULT_SERVER_ID)
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--patch", action="store_true", help="PATCH result back to toolidx")
    parser.add_argument("--archive", action="store_true",
                        help="Archive run to Gitea via toolidx Worker (requires TOOLIDX_API_KEY)")
    args = parser.parse_args()

    result = run_qc(args.install_cmd, args.server_id, verbose=not args.quiet)

    # Classify failure mode (None for clean passes; one of FAILURE_CLASSES otherwise)
    from qc_classify import classify_failure
    tool_results = result.get("qc_tool_results", [])
    all_auth = bool(tool_results) and all(
        tr.get("status") == "needs-auth" for tr in tool_results
    )
    result["failure_class"] = classify_failure(
        result.get("qc_error"),
        result.get("qc_status"),
        hangs_on_start=result.get("hangs_on_start", False),
        requires_env_vars=result.get("requires_env_vars", False),
        external_deps_detected=result.get("external_deps_detected") or [],
        tool_count=result.get("tool_count"),
        all_tools_need_auth=all_auth,
    )

    print("\n" + "=" * 60)
    print("QC RESULT SUMMARY")
    print("=" * 60)
    print(f"  server_id:          {result['server_id']}")
    print(f"  qc_status:          {result['qc_status']}")
    print(f"  failure_class:      {result['failure_class']}")
    print(f"  qc_platform:        {result['qc_platform']}")
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
    tool_results = result.get("qc_tool_results", [])
    if tool_results:
        print(f"\n  per-tool results ({len(tool_results)} tools):")
        for tr in tool_results:
            print(f"    {tr['tool_name']}: {tr['status']} ({tr.get('latency_ms', '-')}ms)")
    if result["qc_error"]:
        print(f"  qc_error:           {result['qc_error']}")

    api_key = os.environ.get("TOOLIDX_API_KEY", "")
    base_url = os.environ.get("TOOLIDX_BASE", "https://toolidx.dev")

    delivery_failed = False

    if args.patch:
        if not api_key:
            print("\n[PATCH] FAILED — TOOLIDX_API_KEY not set", flush=True)
            delivery_failed = True
        elif not patch_toolidx(result, base_url, api_key):
            delivery_failed = True

    if args.archive:
        if not api_key:
            print("\n[ARCHIVE] FAILED — TOOLIDX_API_KEY not set", flush=True)
            delivery_failed = True
        else:
            run_id = result.get("run_id") or hashlib.sha256(
                f"{result['server_id']}{time.time()}".encode()
            ).hexdigest()[:12]
            if not archive_to_gitea(result, run_id, base_url, api_key):
                delivery_failed = True

    if delivery_failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
