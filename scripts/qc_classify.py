#!/usr/bin/env python3
"""
Failure-mode classifier for QC results.

Maps free-form qc_error text + extracted boolean flags into a stable enum.
Used by:
  - qc_test_single.py at end of run_qc() to stamp result["failure_class"]
  - backfill_failure_class.py to populate failure_class on historical rows

Patterns are evaluated in declaration order; first match wins.
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
# Order matters. Each entry: (failure_class, regex pattern, applies-when-status-in)
_PATTERNS: tuple[tuple[str, re.Pattern, Optional[set[str]]], ...] = (
    (
        "install_fail_uvx_resolve",
        re.compile(r"no solution found when resolving|×\s*Failed to resolve|uv::resolve", re.IGNORECASE),
        None,
    ),
    (
        "install_fail_npm_404",
        re.compile(r"\b404 not found\b|code\s+E404|npm error 404", re.IGNORECASE),
        None,
    ),
    (
        "install_fail_npm_timeout",
        re.compile(r"\bDownloading [^\n]+MiB\b|ETIMEDOUT|network timeout|socket hang up", re.IGNORECASE),
        None,
    ),
    (
        "bad_entrypoint_shim",
        re.compile(r"unexpected positional arguments|module not found.*\.bin/|Cannot find module .*\.bin", re.IGNORECASE),
        None,
    ),
    (
        "tools_list_error",
        re.compile(r"tools/list.*error|method not found.*tools", re.IGNORECASE),
        None,
    ),
    (
        "protocol_error",
        re.compile(r"json.*decode|invalid json|jsonrpc.*invalid|malformed.*response", re.IGNORECASE),
        None,
    ),
)

_AUTH_TEXT = re.compile(
    r"unauthorized|forbidden|authentication required|invalid api key|"
    r"bad credentials|missing token|api[_ ]?key|access[_ ]?token|credential|"
    r"please set .* (?:token|key|secret)|env(?:ironment)? variable .* (?:required|missing|not set)",
    re.IGNORECASE,
)


def classify_failure(
    qc_error: Optional[str],
    qc_status: Optional[str],
    *,
    hangs_on_start: bool = False,
    requires_env_vars: bool = False,
    external_deps_detected: Optional[Iterable[str]] = None,
    tool_count: Optional[int] = None,
    tools_list_had_error: bool = False,
    all_tools_need_auth: bool = False,
) -> Optional[str]:
    """Return one of FAILURE_CLASSES, or None when the row is a clean pass.

    Rules of thumb (in evaluation order):
      passed + tools > 0 + not auth-only  -> None (no failure to classify)
      passed + tools = 0                  -> tools_list_empty
      passed + auth-only tools            -> auth_required
      hangs_on_start flag                 -> hangs_on_start
      tools_list_had_error flag           -> tools_list_error
      external_deps_detected non-empty    -> missing_external_dep
      requires_env_vars / auth text       -> missing_env_vars
      qc_error matches a pattern          -> matched class
      everything else with non-pass status -> unknown
    """
    status = (qc_status or "").lower()

    if status == "passed":
        if tool_count == 0:
            return "tools_list_empty"
        if all_tools_need_auth:
            return "auth_required"
        return None  # genuine pass — don't classify

    # Strong signals first — these win over text matching.
    if hangs_on_start:
        return "hangs_on_start"
    if tools_list_had_error:
        return "tools_list_error"
    if external_deps_detected:
        return "missing_external_dep"

    text = qc_error or ""

    if requires_env_vars or _AUTH_TEXT.search(text):
        return "missing_env_vars"

    for cls, pat, allowed_statuses in _PATTERNS:
        if allowed_statuses and status not in allowed_statuses:
            continue
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
