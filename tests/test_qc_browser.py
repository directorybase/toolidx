"""
Unit tests for scripts/qc_test_browser.py

Run with:
    python3 -m unittest tests/test_qc_browser.py -v
    # or with pytest if available:
    python3 -m pytest tests/test_qc_browser.py -v
"""

import sys
import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Ensure scripts/ is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import qc_test_browser as qb


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_network_event(url: str, headers: dict | None = None) -> dict:
    return {
        "type": "network_request",
        "url": url,
        "headers": headers or {},
    }


def _make_fs_event(path: str) -> dict:
    return {
        "type": "filesystem_write",
        "path": path,
    }


# ---------------------------------------------------------------------------
# Browser detection tests
# ---------------------------------------------------------------------------

class TestBrowserDetection(unittest.TestCase):

    def test_browser_detection_positive_readme_playwright(self):
        """Server with 'playwright' in README is detected as browser-based."""
        readme = "This server uses playwright to automate web browsing."
        self.assertTrue(qb.is_browser_based(readme_text=readme))

    def test_browser_detection_positive_readme_headless(self):
        """Server with 'headless' in README is detected as browser-based."""
        readme = "Runs headless Chrome to render pages."
        self.assertTrue(qb.is_browser_based(readme_text=readme))

    def test_browser_detection_positive_readme_screenshot(self):
        """Server with 'screenshot' in README is detected as browser-based."""
        readme = "Take a screenshot of any URL."
        self.assertTrue(qb.is_browser_based(readme_text=readme))

    def test_browser_detection_positive_tool_navigate(self):
        """Tool named 'navigate' flags server as browser-based."""
        tools = [{"name": "navigate", "description": "Navigate to a URL"}]
        self.assertTrue(qb.is_browser_based(tool_schemas=tools))

    def test_browser_detection_positive_tool_screenshot(self):
        """Tool named 'take_screenshot' flags server as browser-based."""
        tools = [{"name": "take_screenshot", "description": "Capture page"}]
        self.assertTrue(qb.is_browser_based(tool_schemas=tools))

    def test_browser_detection_negative(self):
        """Pure API server (no browser keywords) is not browser-based."""
        readme = "A simple REST API wrapper. Connects to external services via HTTP."
        tools = [
            {"name": "list_files", "description": "List files in a directory"},
            {"name": "read_file", "description": "Read contents of a file"},
            {"name": "create_issue", "description": "Create a GitHub issue"},
        ]
        self.assertFalse(qb.is_browser_based(readme_text=readme, tool_schemas=tools))

    def test_browser_detection_empty_inputs(self):
        """Empty inputs are not browser-based."""
        self.assertFalse(qb.is_browser_based())
        self.assertFalse(qb.is_browser_based(readme_text="", tool_schemas=[]))

    def test_browser_detection_case_insensitive_readme(self):
        """README keyword matching is case-insensitive."""
        readme = "Uses PUPPETEER for automation."
        self.assertTrue(qb.is_browser_based(readme_text=readme))

    def test_web_scraping_keyword(self):
        readme = "Provides web scraping capabilities via headless browser."
        self.assertTrue(qb.is_browser_based(readme_text=readme))

    def test_goto_tool(self):
        tools = [{"name": "goto_url", "description": "Navigate to URL"}]
        self.assertTrue(qb.is_browser_based(tool_schemas=tools))

    def test_no_false_positive_on_unrelated_text(self):
        readme = "A database interface for reading and writing SQL records."
        tools = [{"name": "query_db", "description": "Run SQL query"}]
        self.assertFalse(qb.is_browser_based(readme_text=readme, tool_schemas=tools))


# ---------------------------------------------------------------------------
# SideEffectDetector analysis tests (no real browser needed)
# ---------------------------------------------------------------------------

class TestSideEffectAnalysis(unittest.TestCase):
    """Tests for SideEffectDetector.analyze() — pure logic, no browser."""

    def _detector(self, allowed=None):
        return qb.SideEffectDetector(allowed_domains=allowed)

    def test_side_effect_clean_no_events(self):
        """No events -> clean report."""
        d = self._detector()
        report = d.analyze([])
        self.assertTrue(report.clean)
        self.assertEqual(report.unexpected_network, [])
        self.assertEqual(report.credential_leak, [])
        self.assertEqual(report.filesystem_write, [])

    def test_side_effect_clean_localhost_only(self):
        """Requests to localhost are not unexpected."""
        events = [
            _make_network_event("http://localhost:3000/api"),
            _make_network_event("http://127.0.0.1:8080/health"),
        ]
        d = self._detector()
        report = d.analyze(events)
        self.assertTrue(report.clean)
        self.assertEqual(report.unexpected_network, [])

    def test_side_effect_unexpected_network(self):
        """Request to an external domain is flagged as unexpected_network."""
        events = [_make_network_event("https://evil.example.com/exfil")]
        d = self._detector()
        report = d.analyze(events)
        self.assertFalse(report.clean)
        self.assertIn("https://evil.example.com/exfil", report.unexpected_network)

    def test_side_effect_unexpected_network_allowed_domain_not_flagged(self):
        """Requests to explicitly allowed domains are not flagged."""
        events = [_make_network_event("https://api.github.com/repos")]
        d = self._detector(allowed=["api.github.com"])
        report = d.analyze(events)
        self.assertTrue(report.clean)
        self.assertEqual(report.unexpected_network, [])

    def test_credential_leak_detection_url_token(self):
        """URL containing 'token=' is flagged as credential_leak."""
        url = "https://api.example.com/data?token=supersecret123"
        events = [_make_network_event(url)]
        d = self._detector()
        report = d.analyze(events)
        self.assertFalse(report.clean)
        self.assertIn(url, report.credential_leak)

    def test_credential_leak_detection_url_key(self):
        """URL containing 'key=' is flagged as credential_leak."""
        url = "https://maps.example.com/?key=AIzaXXX"
        events = [_make_network_event(url)]
        d = self._detector()
        report = d.analyze(events)
        self.assertFalse(report.clean)
        self.assertIn(url, report.credential_leak)

    def test_credential_leak_detection_url_password(self):
        """URL containing 'password=' is flagged."""
        url = "https://example.com/login?password=hunter2"
        events = [_make_network_event(url)]
        d = self._detector()
        report = d.analyze(events)
        self.assertFalse(report.clean)
        self.assertIn(url, report.credential_leak)

    def test_credential_leak_in_header(self):
        """Authorization header value triggers credential_leak."""
        events = [
            _make_network_event(
                "https://api.example.com/data",
                headers={"Authorization": "Bearer secret-token-xyz"},
            )
        ]
        d = self._detector()
        report = d.analyze(events)
        self.assertFalse(report.clean)
        self.assertTrue(report.credential_leak)

    def test_filesystem_write_inside_tmp_is_clean(self):
        """Filesystem writes inside /tmp/ are not flagged."""
        events = [_make_fs_event("/tmp/qc_work/output.txt")]
        d = self._detector()
        report = d.analyze(events)
        self.assertTrue(report.clean)
        self.assertEqual(report.filesystem_write, [])

    def test_filesystem_write_outside_tmp_flagged(self):
        """Filesystem writes outside /tmp/ are flagged."""
        events = [_make_fs_event("/home/user/.ssh/known_hosts")]
        d = self._detector()
        report = d.analyze(events)
        self.assertFalse(report.clean)
        self.assertIn("/home/user/.ssh/known_hosts", report.filesystem_write)

    def test_multiple_issues_all_captured(self):
        """Multiple issue types are all captured in the same report."""
        events = [
            _make_network_event("https://exfil.bad.com/data?secret=abc"),
            _make_fs_event("/etc/passwd"),
        ]
        d = self._detector()
        report = d.analyze(events)
        self.assertFalse(report.clean)
        self.assertTrue(report.unexpected_network)
        self.assertTrue(report.credential_leak)
        self.assertTrue(report.filesystem_write)


# ---------------------------------------------------------------------------
# SideEffectReport dataclass
# ---------------------------------------------------------------------------

class TestSideEffectReport(unittest.TestCase):

    def test_to_dict_clean(self):
        r = qb.SideEffectReport()
        d = r.to_dict()
        self.assertTrue(d["clean"])
        self.assertEqual(d["unexpected_network"], [])
        self.assertEqual(d["credential_leak"], [])
        self.assertEqual(d["filesystem_write"], [])

    def test_to_dict_dirty(self):
        r = qb.SideEffectReport(
            unexpected_network=["https://bad.com"],
            credential_leak=["https://x.com?token=y"],
            filesystem_write=["/etc/hosts"],
            clean=False,
        )
        d = r.to_dict()
        self.assertFalse(d["clean"])
        self.assertEqual(d["unexpected_network"], ["https://bad.com"])


# ---------------------------------------------------------------------------
# run_browser_qc graceful degradation
# ---------------------------------------------------------------------------

class TestRunBrowserQcDegradation(unittest.TestCase):

    def test_skips_gracefully_when_not_capable(self):
        """run_browser_qc returns skipped status when browser not available."""
        with patch.object(qb, "BROWSER_CAPABLE", False):
            result = qb.run_browser_qc("test-server", [], verbose=False)
        self.assertEqual(result["qc_status"], "skipped")
        self.assertIsNotNone(result["qc_error"])
        err = result["qc_error"].lower()
        self.assertTrue("skipped" in err or "not available" in err)

    def test_artifact_dir_created(self):
        """Artifact directory is created under qc-artifacts/browser/."""
        with tempfile.TemporaryDirectory() as tmp:
            old_cwd = os.getcwd()
            os.chdir(tmp)
            try:
                with patch.object(qb, "BROWSER_CAPABLE", False):
                    result = qb.run_browser_qc("my-server", [], verbose=False)
                artifact_dir = Path(tmp) / "qc-artifacts" / "browser"
                self.assertTrue(artifact_dir.exists())
                files = list(artifact_dir.glob("my-server_*.json"))
                self.assertEqual(len(files), 1)
                loaded = json.loads(files[0].read_text())
                self.assertEqual(loaded["server_id"], "my-server")
            finally:
                os.chdir(old_cwd)


if __name__ == "__main__":
    unittest.main(verbosity=2)
