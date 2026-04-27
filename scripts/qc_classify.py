#!/usr/bin/env python3
"""
Failure-mode classifier for QC results.

Maps free-form qc_error text + extracted boolean flags into a stable enum.
Used by:
  - qc_test_single.py at end of run_qc() to stamp result["failure_class"]
  - backfill_failure_class.py to populate failure_class on historical rows

Patterns are evaluated in declaration order; first match wins. Text patterns
take precedence over the historical external_deps_detected list (which is
substring-only and false-positives on package names like "ffmpeg-mcp").
"""

import re
from typing import Iterable, Optional

# ── Enum ──────────────────────────────────────────────────────────────────────
FAILURE_CLASSES = (
    "install_fail_uvx_resolve",
    "install_fail_npm_404",
    "install_fail_npm_timeout",
    "bad_entrypoint_shim",
    "missing_env_vars",
    "missing_external_dep",
    "hangs_on_start",
    "protocol_error",
    "tools_list_empty",
    "tools_list_error",
    "auth_required",
    "unknown",
)

# ── Pattern table ─────────────────────────────────────────────────────────────
# Order matters. Each entry: (failure_class, regex pattern)
# Text-based patterns evaluated BEFORE external_deps fallback to avoid the
# substring-match false-positive ("ffmpeg-mcp" looks like missing ffmpeg).
_PATTERNS: tuple[tuple[str, re.Pattern], ...] = (
    # Package not on registry (covers npm 404, pip Could not find, uvx not in registry)
    (
        "install_fail_npm_404",
        re.compile(
            r"\bnpm error 404\b|\bcode\s+E404\b|\b404 Not Found\b|"
            r"could not find a version that satisfies|"
            r"no matching distribution found|"
            r"was not found in the package registry|"
            r"could not determine executable to run",
            re.IGNORECASE,
        ),
    ),
    # uv/uvx dependency resolution failure (covers Python version conflicts, transitive deps)
    (
        "install_fail_uvx_resolve",
        re.compile(
            r"no solution found when resolving|"
            r"because [^\n]+ requires python|"
            r"resolutionimpossible|"
            r"\buv::resolve\b",
            re.IGNORECASE,
        ),
    ),
    # Slow download / network timeout during install
    (
        "install_fail_npm_timeout",
        re.compile(
            r"\bETIMEDOUT\b|\bsocket hang up\b|network timeout|connection reset|"
            r"econnreset",
            re.IGNORECASE,
        ),
    ),
    # Bin shim wrong (npm shim invokes node twice, or wrong shebang)
    (
        "bad_entrypoint_shim",
        re.compile(
            r"unexpected positional arguments|"
            r"cannot find module .*\.bin/|"
            r"module not found.*\.bin/",
            re.IGNORECASE,
        ),
    ),
    # Missing external binary (must say WHY it's missing, not just mention name)
    (
        "missing_external_dep",
        re.compile(
            r"\bENOENT\b|"
            r"\bcommand not found\b|"
            r"\bis not installed\b|"
            r"\bspawn [A-Za-z0-9_./-]+ ENOENT\b|"
            r"\bno such file or directory: [\"']?[A-Za-z0-9_./-]*(?:ffmpeg|ffprobe|docker|chromium|chrome|playwright|imagemagick|pandoc|sqlite3)\b",
            re.IGNORECASE,
        ),
    ),
    # MCP/JSON-RPC protocol errors (StreamableHTTPError, malformed JSON, etc.)
    (
        "protocol_error",
        re.compile(
            r"streamablehttperror|jsonrpc.*invalid|"
            r"invalid json|json\.?decode|malformed.*response|"
            r"throw new (?:StreamableHTTPError|ProtocolError)",
            re.IGNORECASE,
        ),
    ),
    # tools/list itself errored (not just empty)
    (
        "tools_list_error",
        re.compile(
            r"tools/list.*error|method not found.*tools",
            re.IGNORECASE,
        ),
    ),
)

# Auth-required signals in qc_error text. Scanned BEFORE the pattern table.
_AUTH_TEXT = re.compile(
    r"\bunauthorized\b|\bforbidden\b|authentication required|invalid api key|"
    r"bad credentials|missing token|"
    r"(?:api[_ ]?key|access[_ ]?token|secret|credential)s?\b[^\n]{0,80}\brequired\b|"
    r"please set .{0,40}(?:token|key|secret)|"
    r"\benv(?:ironment)? variable\b[^\n]{0,80}\b(?:required|missing|not set)\b|"
    r"\b[A-Z][A-Z0-9_]+_(?:TOKEN|API_KEY|SECRET|CREDENTIALS?)\b[^\n]{0,80}\b(?:required|missing|not set)\b",
    re.IGNORECASE,
)


def classify_failure(
    qc_error: Optional[str],
    qc_status: Optional[str],
    *,
    hangs_on_start: bool = False,
    requires_env_vars: bool = False,
    external_deps_detected: Optional[Iterable[str]] = None,  # accepted for API compat; unused
    tool_count: Optional[int] = None,
    tools_list_had_error: bool = False,
    all_tools_need_auth: bool = False,
) -> Optional[str]:
    """Return one of FAILURE_CLASSES, or None for genuine clean passes.

    Evaluation order (first match wins):
      passed + tools > 0 + not auth-only  -> None
      passed + tools = 0                  -> tools_list_empty
      passed + auth-only tools            -> auth_required
      hangs_on_start flag                 -> hangs_on_start
      tools_list_had_error flag           -> tools_list_error
      auth-keyword text                   -> missing_env_vars
      requires_env_vars flag              -> missing_env_vars
      pattern table                       -> matched class
      non-pass status, no match           -> unknown

    Note: external_deps_detected is intentionally ignored. The historical D1
    column populated via substring match has too many false positives (e.g.
    package names containing "ffmpeg" or "git"). The pattern table catches
    real missing-dep failures via ENOENT / command-not-found phrasing.
    """
    status = (qc_status or "").lower()

    if status == "passed":
        if tool_count == 0:
            return "tools_list_empty"
        if all_tools_need_auth:
            return "auth_required"
        return None

    if hangs_on_start:
        return "hangs_on_start"
    if tools_list_had_error:
        return "tools_list_error"

    text = qc_error or ""

    # Auth/env-var signals — keyword scan in stderr
    if _AUTH_TEXT.search(text):
        return "missing_env_vars"
    if requires_env_vars:
        return "missing_env_vars"

    for cls, pat in _PATTERNS:
        if pat.search(text):
            return cls

    if status in ("failed", "error", "skipped"):
        return "unknown"

    return None


# ── CLI for ad-hoc classification ─────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Classify a single qc_error string from CLI/stdin.")
    parser.add_argument("--status", default="failed")
    parser.add_argument("--qc-error", default=None)
    parser.add_argument("--hangs-on-start", action="store_true")
    parser.add_argument("--requires-env-vars", action="store_true")
    parser.add_argument("--tool-count", type=int, default=None)
    args = parser.parse_args()

    qc_error = args.qc_error
    if qc_error is None and not sys.stdin.isatty():
        qc_error = sys.stdin.read()

    cls = classify_failure(
        qc_error,
        args.status,
        hangs_on_start=args.hangs_on_start,
        requires_env_vars=args.requires_env_vars,
        tool_count=args.tool_count,
    )
    print(json.dumps({"failure_class": cls}))
