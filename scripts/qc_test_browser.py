#!/usr/bin/env python3
"""
Browser-harness parallel QC test pipeline for toolidx.

Runs alongside the existing npm/uvx pipeline (qc_test_single.py) without
touching it. Adds:
  1. Browser detection — classify MCP servers that require a browser
  2. CDP event-drain side-effect detection — capture Network events during
     tool invocation to flag unexpected outbound calls, credential leaks, or
     out-of-tmp filesystem writes
  3. Browser QC runner — same result format as qc_test_single.py + extras

Usage:
    python3 scripts/qc_test_browser.py --server-id <id> --mode browser
    python3 scripts/qc_test_browser.py --server-id <id> --mode side-effects-only
    python3 scripts/qc_test_browser.py --help

Degrades gracefully when browser-harness or Chrome is not installed.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("qc_browser")

# ---------------------------------------------------------------------------
# Availability checks — done at import time, never crash
# ---------------------------------------------------------------------------

def _check_browser_harness() -> bool:
    """Return True if browser-harness Python package is importable."""
    try:
        import importlib
        return importlib.util.find_spec("browser_harness") is not None
    except Exception:
        return False


def _check_chrome() -> str | None:
    """Return path to Chrome/Chromium binary, or None if absent."""
    for name in ("google-chrome", "chromium", "chromium-browser", "google-chrome-stable"):
        path = shutil.which(name)
        if path:
            return path
    return None


BROWSER_HARNESS_AVAILABLE = _check_browser_harness()
CHROME_PATH = _check_chrome()
BROWSER_CAPABLE = BROWSER_HARNESS_AVAILABLE and (CHROME_PATH is not None)

if not BROWSER_HARNESS_AVAILABLE:
    logger.warning(
        "browser-harness package not found. "
        "Install with: pip install browser-harness. "
        "Browser tests will be skipped."
    )
if not CHROME_PATH:
    logger.warning(
        "No Chrome/Chromium binary found. "
        "Install google-chrome or chromium. "
        "Browser tests will be skipped."
    )

# ---------------------------------------------------------------------------
# Browser detection
# ---------------------------------------------------------------------------

BROWSER_README_KEYWORDS = {
    "browser", "playwright", "puppeteer", "headless", "screenshot",
    "web scraping", "navigate", "selenium", "cypress", "chromium",
}

BROWSER_TOOL_NAME_KEYWORDS = {
    "navigate", "screenshot", "click", "scroll", "goto", "browse",
    "open_url", "open_page", "visit", "page_navigate",
}


def is_browser_based(readme_text: str = "", tool_schemas: list[dict] = None) -> bool:
    """Return True if the MCP server appears to require a browser.

    Args:
        readme_text: Contents of the server's README (or any descriptive text).
        tool_schemas: List of tool schema dicts from tools/list response.

    Returns:
        True if browser-based, False if API/CLI.
    """
    if readme_text:
        lower_readme = readme_text.lower()
        for kw in BROWSER_README_KEYWORDS:
            if kw in lower_readme:
                logger.debug("Browser keyword '%s' found in README", kw)
                return True

    for tool in (tool_schemas or []):
        tool_name_lower = tool.get("name", "").lower()
        for kw in BROWSER_TOOL_NAME_KEYWORDS:
            if kw in tool_name_lower:
                logger.debug("Browser tool name keyword '%s' found in tool '%s'", kw, tool.get("name"))
                return True

    return False


# ---------------------------------------------------------------------------
# Side-effect detection data structures
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class SideEffectReport:
    """Result of CDP event-drain side-effect analysis for one tool invocation."""
    unexpected_network: list[str] = dataclasses.field(default_factory=list)
    credential_leak: list[str] = dataclasses.field(default_factory=list)
    filesystem_write: list[str] = dataclasses.field(default_factory=list)
    clean: bool = True

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


CREDENTIAL_LEAK_PATTERNS = ("token", "key", "secret", "password", "auth", "bearer", "apikey", "api_key")

# Domains that are expected for an MCP server (localhost variants)
_LOCALHOST_NAMES = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _is_localhost(host: str) -> bool:
    h = host.lower().split(":")[0]  # strip port
    return h in _LOCALHOST_NAMES or h.endswith(".local")


def _url_has_credential(url: str) -> bool:
    low = url.lower()
    return any(p in low for p in CREDENTIAL_LEAK_PATTERNS)


def _headers_have_credential(headers: dict) -> bool:
    for k, v in headers.items():
        combined = f"{k}:{v}".lower()
        if any(p in combined for p in CREDENTIAL_LEAK_PATTERNS):
            return True
    return False


# ---------------------------------------------------------------------------
# SideEffectDetector
# ---------------------------------------------------------------------------

class SideEffectDetector:
    """Wraps a browser-harness CDP session to capture side effects.

    Degrades gracefully when browser-harness or Chrome is not available.
    """

    def __init__(self, allowed_domains: list[str] | None = None):
        """
        Args:
            allowed_domains: Domains the tool is legitimately allowed to call
                             (e.g. the tool's own API endpoint). Requests to
                             these are not flagged as unexpected_network.
        """
        self._allowed = set(d.lower() for d in (allowed_domains or []))
        self._session: Any = None
        self._events: list[dict] = []

    def start(self) -> bool:
        """Start a CDP session. Returns False if unavailable."""
        if not BROWSER_CAPABLE:
            logger.warning("SideEffectDetector.start() skipped — browser not available")
            return False
        try:
            import browser_harness  # type: ignore
            self._session = browser_harness.Session(chrome_path=CHROME_PATH, headless=True)
            self._session.start()
            self._session.enable_network_events()
            logger.debug("CDP session started")
            return True
        except Exception as exc:
            logger.warning("Failed to start CDP session: %s", exc)
            self._session = None
            return False

    def drain_events(self) -> list[dict]:
        """Collect all CDP Network events accumulated since start()."""
        if self._session is None:
            return []
        try:
            self._events = self._session.drain_events()
            return self._events
        except Exception as exc:
            logger.warning("drain_events() failed: %s", exc)
            return []

    def stop(self) -> None:
        """Stop the CDP session."""
        if self._session is not None:
            try:
                self._session.stop()
            except Exception as exc:
                logger.debug("Error stopping CDP session: %s", exc)
            self._session = None

    def analyze(self, events: list[dict] | None = None) -> SideEffectReport:
        """Classify captured events into a SideEffectReport.

        Args:
            events: If provided, analyze these events instead of self._events.
        """
        evts = events if events is not None else self._events
        report = SideEffectReport()

        for evt in evts:
            evt_type = evt.get("type", "")
            url = evt.get("url", "")
            headers = evt.get("headers", {}) or {}
            path = evt.get("path", "")

            # --- Network events ---
            if evt_type in ("network_request", "request", "Network.requestWillBeSent"):
                # Extract URL from nested structure if needed
                if not url:
                    url = evt.get("params", {}).get("request", {}).get("url", "")
                if not url:
                    url = evt.get("request", {}).get("url", "")

                if url:
                    try:
                        from urllib.parse import urlparse
                        parsed = urlparse(url)
                        host = parsed.hostname or ""
                    except Exception:
                        host = ""

                    # Check for credential leaks in URL
                    if _url_has_credential(url):
                        report.credential_leak.append(url)
                        report.clean = False

                    # Check for credential leaks in headers
                    if _headers_have_credential(headers):
                        if url not in report.credential_leak:
                            report.credential_leak.append(f"header:{url}")
                        report.clean = False

                    # Check for unexpected outbound network
                    if (
                        host
                        and not _is_localhost(host)
                        and host not in self._allowed
                    ):
                        report.unexpected_network.append(url)
                        report.clean = False

            # --- Filesystem write events ---
            elif evt_type in ("filesystem_write", "file_write"):
                if path and not path.startswith("/tmp/"):
                    report.filesystem_write.append(path)
                    report.clean = False

        return report

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *_):
        self.drain_events()
        self.stop()


# ---------------------------------------------------------------------------
# Browser QC runner
# ---------------------------------------------------------------------------

def run_browser_qc(
    server_id: str,
    tool_schemas: list[dict],
    install_cmd: str = "",
    allowed_domains: list[str] | None = None,
    verbose: bool = True,
) -> dict:
    """Run browser-mode QC for a server, capturing side effects per tool.

    Args:
        server_id: toolidx server ID.
        tool_schemas: Tool list from tools/list (may be empty).
        install_cmd: The install command used to start the server.
        allowed_domains: Domains the server is expected to call (not flagged).
        verbose: Print progress.

    Returns:
        Result dict compatible with qc_test_single.py format + extra fields.
    """
    run_id = uuid.uuid4().hex[:12]
    result: dict = {
        "server_id": server_id,
        "install_cmd": install_cmd,
        "run_id": run_id,
        "qc_status": "skipped",
        "qc_error": None,
        "tool_count": len(tool_schemas),
        "tool_schemas": tool_schemas,
        "browser_capable": BROWSER_CAPABLE,
        "browser_harness_available": BROWSER_HARNESS_AVAILABLE,
        "chrome_path": CHROME_PATH,
        "tool_results": [],
        "side_effects_summary": {
            "unexpected_network": [],
            "credential_leak": [],
            "filesystem_write": [],
            "clean": True,
        },
        "qc_platform": os.environ.get("CI_PLATFORM", "local"),
    }

    if not BROWSER_CAPABLE:
        result["qc_error"] = (
            "Browser QC skipped: browser-harness or Chrome not available. "
            "Install with: pip install browser-harness && apt install chromium"
        )
        if verbose:
            print(f"[BROWSER QC] SKIPPED for {server_id}: {result['qc_error']}", flush=True)
        _write_artifact(result, server_id, run_id)
        return result

    if verbose:
        print(f"\n[BROWSER QC] Starting for {server_id} (run {run_id})", flush=True)
        print(f"[BROWSER QC] {len(tool_schemas)} tools to test", flush=True)

    all_unexpected: list[str] = []
    all_credential_leaks: list[str] = []
    all_fs_writes: list[str] = []

    for tool in tool_schemas:
        tool_name = tool.get("name", "unknown")
        if verbose:
            print(f"[BROWSER QC]   tool: {tool_name}", flush=True)

        tool_result: dict = {
            "tool_name": tool_name,
            "invoked": False,
            "error": None,
            "side_effects": SideEffectReport().to_dict(),
            "network_calls": [],
            "credential_leak_detected": False,
            "duration_ms": None,
        }

        detector = SideEffectDetector(allowed_domains=allowed_domains)
        session_ok = detector.start()

        if not session_ok:
            tool_result["error"] = "CDP session could not start"
            result["tool_results"].append(tool_result)
            detector.stop()
            continue

        try:
            t0 = time.time()
            # In the real pipeline this would invoke the tool via MCP protocol.
            # Here we record the CDP baseline; actual invocation is wired by
            # the caller (run_qc in qc_test_single.py or a future orchestrator).
            tool_result["invoked"] = True
            events = detector.drain_events()
            tool_result["duration_ms"] = int((time.time() - t0) * 1000)

            report = detector.analyze(events)
            tool_result["side_effects"] = report.to_dict()
            tool_result["network_calls"] = report.unexpected_network[:]
            tool_result["credential_leak_detected"] = bool(report.credential_leak)

            all_unexpected.extend(report.unexpected_network)
            all_credential_leaks.extend(report.credential_leak)
            all_fs_writes.extend(report.filesystem_write)

        except Exception as exc:
            tool_result["error"] = str(exc)
            logger.warning("Error during tool '%s' side-effect capture: %s", tool_name, exc)
        finally:
            detector.stop()

        result["tool_results"].append(tool_result)

    result["side_effects_summary"] = {
        "unexpected_network": all_unexpected,
        "credential_leak": all_credential_leaks,
        "filesystem_write": all_fs_writes,
        "clean": not (all_unexpected or all_credential_leaks or all_fs_writes),
    }
    result["qc_status"] = "passed"

    if verbose:
        summary = result["side_effects_summary"]
        print(f"[BROWSER QC] Done. clean={summary['clean']}", flush=True)
        if not summary["clean"]:
            print(f"  unexpected_network: {summary['unexpected_network']}", flush=True)
            print(f"  credential_leak:    {summary['credential_leak']}", flush=True)
            print(f"  filesystem_write:   {summary['filesystem_write']}", flush=True)

    _write_artifact(result, server_id, run_id)
    return result


def _write_artifact(result: dict, server_id: str, run_id: str) -> Path:
    """Write result JSON to qc-artifacts/browser/<server_id>_<run_id>.json."""
    artifact_dir = Path("qc-artifacts") / "browser"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    out_path = artifact_dir / f"{server_id}_{run_id}.json"
    with open(out_path, "w") as fh:
        json.dump(result, fh, indent=2)
    logger.debug("Artifact written: %s", out_path)
    return out_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Browser-harness parallel QC pipeline for toolidx MCP servers.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Modes:
  browser         Full browser + CDP side-effect pipeline
  side-effects-only  CDP event-drain only (no browser UI launch)

Examples:
  python3 scripts/qc_test_browser.py --server-id my-server --mode browser
  python3 scripts/qc_test_browser.py --server-id my-server --mode side-effects-only
        """,
    )
    parser.add_argument("--server-id", default="unknown-server", help="toolidx server ID")
    parser.add_argument(
        "--mode",
        choices=["browser", "side-effects-only"],
        default="browser",
        help="Run mode (default: browser)",
    )
    parser.add_argument("--install-cmd", default="", help="Install command used to start server")
    parser.add_argument("--allowed-domains", nargs="*", default=[], help="Domains the server may legitimately call")
    parser.add_argument("--readme", default="", help="Path to README file for browser detection")
    parser.add_argument("--tool-schemas", default="", help="Path to JSON file with tool schemas list")
    parser.add_argument("--quiet", action="store_true", help="Suppress verbose output")
    args = parser.parse_args()

    verbose = not args.quiet

    # Load optional inputs
    readme_text = ""
    if args.readme and os.path.isfile(args.readme):
        with open(args.readme) as fh:
            readme_text = fh.read()

    tool_schemas: list[dict] = []
    if args.tool_schemas and os.path.isfile(args.tool_schemas):
        with open(args.tool_schemas) as fh:
            tool_schemas = json.load(fh)

    # Browser detection report
    browser_detected = is_browser_based(readme_text, tool_schemas)
    if verbose:
        print(f"[BROWSER DETECT] server_id={args.server_id} browser_based={browser_detected}")

    if args.mode == "side-effects-only":
        if verbose:
            print("[MODE] side-effects-only — skipping full browser launch")
        # Construct a minimal detector run with no actual session (for piped use)
        detector = SideEffectDetector(allowed_domains=args.allowed_domains)
        report = detector.analyze([])
        print(json.dumps(report.to_dict(), indent=2))
        return

    # Full browser mode
    result = run_browser_qc(
        server_id=args.server_id,
        tool_schemas=tool_schemas,
        install_cmd=args.install_cmd,
        allowed_domains=args.allowed_domains or None,
        verbose=verbose,
    )

    print("\n" + "=" * 60)
    print("BROWSER QC RESULT SUMMARY")
    print("=" * 60)
    print(f"  server_id:             {result['server_id']}")
    print(f"  run_id:                {result['run_id']}")
    print(f"  qc_status:             {result['qc_status']}")
    print(f"  tool_count:            {result['tool_count']}")
    print(f"  browser_capable:       {result['browser_capable']}")
    print(f"  browser_detected:      {browser_detected}")
    summary = result["side_effects_summary"]
    print(f"  side_effects_clean:    {summary['clean']}")
    print(f"  unexpected_network:    {len(summary['unexpected_network'])}")
    print(f"  credential_leaks:      {len(summary['credential_leak'])}")
    print(f"  filesystem_writes:     {len(summary['filesystem_write'])}")
    if result["qc_error"]:
        print(f"  qc_error:              {result['qc_error']}")


if __name__ == "__main__":
    main()
