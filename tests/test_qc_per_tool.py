"""
Unit and integration tests for per-tool verification additions to qc_test_single.py.

Run with: python3 -m pytest tests/test_qc_per_tool.py -v
"""

import importlib
import json
import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Import the module under test
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
qc = importlib.import_module("qc_test_single")


# ---------------------------------------------------------------------------
# Auth detection
# ---------------------------------------------------------------------------

class TestAuthDetection(unittest.TestCase):
    """Tests for is_auth_error() — spec: Auth detection rules, rule #1."""

    def test_unauthorized_lowercase(self):
        self.assertTrue(qc.is_auth_error("Error: unauthorized access"))

    def test_forbidden(self):
        self.assertTrue(qc.is_auth_error("403 Forbidden"))

    def test_401_numeric(self):
        self.assertTrue(qc.is_auth_error("HTTP 401"))

    def test_invalid_api_key(self):
        self.assertTrue(qc.is_auth_error("Invalid API Key provided"))

    def test_bad_credentials(self):
        self.assertTrue(qc.is_auth_error("Bad credentials"))

    def test_missing_token(self):
        self.assertTrue(qc.is_auth_error("missing token in request"))

    def test_authentication_required(self):
        self.assertTrue(qc.is_auth_error("Authentication Required"))

    def test_no_auth_error(self):
        self.assertFalse(qc.is_auth_error("Everything is fine"))

    def test_empty_string(self):
        self.assertFalse(qc.is_auth_error(""))

    def test_case_insensitive(self):
        self.assertTrue(qc.is_auth_error("UNAUTHORIZED"))


# ---------------------------------------------------------------------------
# Schema auth detection
# ---------------------------------------------------------------------------

class TestSchemaAuthDetection(unittest.TestCase):
    """Tests for schema_requires_auth() — spec: Auth detection rules, rule #2."""

    def _tool(self, required, props=None):
        props = props or {k: {"type": "string"} for k in required}
        return {"inputSchema": {"type": "object", "properties": props, "required": required}}

    def test_api_key_required(self):
        self.assertTrue(qc.schema_requires_auth(self._tool(["api_key", "repo"])))

    def test_access_token_required(self):
        self.assertTrue(qc.schema_requires_auth(self._tool(["access_token"])))

    def test_bearer_required(self):
        self.assertTrue(qc.schema_requires_auth(self._tool(["bearer"])))

    def test_no_auth_props(self):
        self.assertFalse(qc.schema_requires_auth(self._tool(["query", "limit"])))

    def test_auth_prop_not_required(self):
        tool = {
            "inputSchema": {
                "type": "object",
                "properties": {"api_key": {"type": "string"}, "q": {"type": "string"}},
                "required": ["q"],
            }
        }
        self.assertFalse(qc.schema_requires_auth(tool))


# ---------------------------------------------------------------------------
# Destructive skip regex
# ---------------------------------------------------------------------------

class TestDestructiveDetection(unittest.TestCase):
    """Tests for is_destructive_tool() — spec: Destructive tools section."""

    def _tool(self, name, ann=None, schema_ext=None):
        t = {"name": name, "annotations": ann or {}, "inputSchema": schema_ext or {}}
        return t

    def test_delete_prefix(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("delete_repo")))

    def test_drop_prefix(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("drop_table")))

    def test_remove_prefix(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("remove_user")))

    def test_truncate_prefix(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("truncate_log")))

    def test_exec_prefix(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("exec_command")))

    def test_write_prefix(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("write_file")))

    def test_execute_prefix(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("execute_query")))

    def test_run_prefix(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("run_script")))

    def test_terminate_prefix(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("terminate_session")))

    def test_safe_tool(self):
        self.assertFalse(qc.is_destructive_tool(self._tool("get_issue")))

    def test_destructive_hint_annotation(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("do_thing", ann={"destructiveHint": True})))

    def test_x_destructive_schema(self):
        self.assertTrue(qc.is_destructive_tool(self._tool("do_thing", schema_ext={"x-destructive": True})))

    def test_list_prefix_not_destructive(self):
        self.assertFalse(qc.is_destructive_tool(self._tool("list_repos")))

    def test_runner_prefix_not_destructive(self):
        # "runner_status" should NOT match — only if name starts with run_
        self.assertFalse(qc.is_destructive_tool(self._tool("runner_status")))

    def test_run_underscore(self):
        # "run_" matches
        self.assertTrue(qc.is_destructive_tool(self._tool("run_")))


# ---------------------------------------------------------------------------
# Naive arg generation
# ---------------------------------------------------------------------------

class TestNaiveArgGeneration(unittest.TestCase):
    """Tests for generate_naive_args() — spec: Naive fallback rules."""

    def test_required_string(self):
        schema = {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}
        self.assertEqual(qc.generate_naive_args(schema), {"q": "test"})

    def test_required_integer(self):
        schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}
        self.assertEqual(qc.generate_naive_args(schema), {"n": 0})

    def test_required_boolean(self):
        schema = {"type": "object", "properties": {"flag": {"type": "boolean"}}, "required": ["flag"]}
        self.assertEqual(qc.generate_naive_args(schema), {"flag": False})

    def test_required_array(self):
        schema = {"type": "object", "properties": {"ids": {"type": "array"}}, "required": ["ids"]}
        self.assertEqual(qc.generate_naive_args(schema), {"ids": []})

    def test_optional_field_omitted(self):
        schema = {"type": "object", "properties": {"q": {"type": "string"}, "opt": {"type": "string"}}, "required": ["q"]}
        result = qc.generate_naive_args(schema)
        self.assertNotIn("opt", result)

    def test_enum_first_value(self):
        schema = {"type": "object", "properties": {"color": {"type": "string", "enum": ["red", "blue"]}}, "required": ["color"]}
        self.assertEqual(qc.generate_naive_args(schema), {"color": "red"})

    def test_format_uri(self):
        schema = {"type": "object", "properties": {"url": {"type": "string", "format": "uri"}}, "required": ["url"]}
        self.assertEqual(qc.generate_naive_args(schema)["url"], "https://example.com")

    def test_format_email(self):
        schema = {"type": "object", "properties": {"addr": {"type": "string", "format": "email"}}, "required": ["addr"]}
        self.assertEqual(qc.generate_naive_args(schema)["addr"], "test@example.com")

    def test_format_uuid(self):
        schema = {"type": "object", "properties": {"id": {"type": "string", "format": "uuid"}}, "required": ["id"]}
        self.assertEqual(qc.generate_naive_args(schema)["id"], "00000000-0000-0000-0000-000000000000")

    def test_format_datetime(self):
        schema = {"type": "object", "properties": {"ts": {"type": "string", "format": "date-time"}}, "required": ["ts"]}
        self.assertEqual(qc.generate_naive_args(schema)["ts"], "2026-01-01T00:00:00Z")

    def test_nested_object(self):
        schema = {
            "type": "object",
            "properties": {
                "nested": {
                    "type": "object",
                    "properties": {"x": {"type": "integer"}},
                    "required": ["x"],
                }
            },
            "required": ["nested"],
        }
        result = qc.generate_naive_args(schema)
        self.assertEqual(result, {"nested": {"x": 0}})

    def test_empty_schema(self):
        self.assertEqual(qc.generate_naive_args({}), {})


# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

class TestPlatformDetection(unittest.TestCase):
    def test_github_actions(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}, clear=False):
            self.assertEqual(qc.detect_platform(), "github")

    def test_gitlab_ci(self):
        with patch.dict(os.environ, {"GITLAB_CI": "true"}, clear=False):
            self.assertEqual(qc.detect_platform(), "gitlab")

    def test_cirrus_ci(self):
        with patch.dict(os.environ, {"CIRRUS_CI": "true"}, clear=False):
            self.assertEqual(qc.detect_platform(), "cirrus")

    def test_unknown(self):
        env = {k: v for k, v in os.environ.items()
               if k not in ("GITHUB_ACTIONS", "GITLAB_CI", "CIRRUS_CI")}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(qc.detect_platform(), "unknown")


# ---------------------------------------------------------------------------
# classify_tool_result
# ---------------------------------------------------------------------------

class TestClassifyToolResult(unittest.TestCase):
    def _tool(self, name="get_data", schema=None):
        return {"name": name, "inputSchema": schema or {}}

    def test_working(self):
        status, ec, es = qc.classify_tool_result('{"content": []}', None, self._tool())
        self.assertEqual(status, "working")
        self.assertIsNone(ec)

    def test_timeout(self):
        status, ec, es = qc.classify_tool_result(None, "timeout", self._tool())
        self.assertEqual(status, "timeout")
        self.assertEqual(ec, "timeout")

    def test_auth_from_text(self):
        status, ec, es = qc.classify_tool_result(None, "Error: 401 Unauthorized", self._tool())
        self.assertEqual(status, "needs-auth")

    def test_auth_from_schema(self):
        tool = {"name": "get", "inputSchema": {
            "type": "object",
            "properties": {"api_key": {"type": "string"}},
            "required": ["api_key"],
        }}
        status, ec, es = qc.classify_tool_result('{"content": []}', None, tool)
        self.assertEqual(status, "needs-auth")

    def test_broken_tool_error(self):
        status, ec, es = qc.classify_tool_result(None, "Something went wrong", self._tool())
        self.assertEqual(status, "broken")

    def test_auth_from_env_vars(self):
        status, ec, es = qc.classify_tool_result('{}', None, self._tool(), required_env_vars=["GITHUB_TOKEN"])
        self.assertEqual(status, "needs-auth")


# ---------------------------------------------------------------------------
# Integration test — filesystem MCP server
# ---------------------------------------------------------------------------

class TestIntegrationFilesystemServer(unittest.TestCase):
    """
    Integration test: run against the reference filesystem MCP server.
    Verifies that qc_tool_results is populated with correct structure.

    Skipped if npx is not available or we're in a minimal CI environment
    that can't install npm packages.
    """

    @classmethod
    def setUpClass(cls):
        import shutil
        if not shutil.which("npx"):
            raise unittest.SkipTest("npx not available")

    def test_filesystem_server_qc_tool_results(self):
        result = qc.run_qc(
            install_cmd="npx -y @modelcontextprotocol/server-filesystem /tmp",
            server_id="test-filesystem-server",
            verbose=False,
        )
        self.assertIn(result["qc_status"], ("passed", "error", "failed"),
                      f"Unexpected qc_status: {result['qc_status']}")

        if result["qc_status"] != "passed":
            self.skipTest(f"Server failed to start: {result.get('qc_error')}")

        tool_results = result.get("qc_tool_results", [])
        self.assertIsInstance(tool_results, list)
        self.assertGreater(len(tool_results), 0, "Expected at least one tool result")

        valid_statuses = {"working", "broken", "needs-auth", "not-tested", "timeout"}
        for tr in tool_results:
            self.assertIn("tool_name", tr)
            self.assertIn("status", tr)
            self.assertIn(tr["status"], valid_statuses,
                          f"Unexpected status '{tr['status']}' for tool {tr['tool_name']}")
            self.assertIn("tested_at", tr)
            if tr["status"] not in ("not-tested",):
                self.assertIn("latency_ms", tr)

        # Verify at least one tool ran (not just skipped)
        tested = [tr for tr in tool_results if tr["status"] != "not-tested"]
        self.assertGreater(len(tested), 0, "Expected at least one tool to be tested")

        # Print summary for PR log
        print("\n[INTEGRATION] qc_tool_results summary:")
        for tr in tool_results:
            print(f"  {tr['tool_name']}: {tr['status']} ({tr.get('latency_ms', '-')}ms)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
