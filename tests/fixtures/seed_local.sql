-- Local D1 seed fixtures for per-server detail page tests.
-- Plan reference: outputs/2026-05-09-claude-toolidx-per-server-pages-plan-v3.md §4.1b
-- Usage: `wrangler d1 execute toolidx --local --file=tests/fixtures/seed_local.sql`
--
-- 5 sample rows covering all indexability tiers and one JSON-LD injection probe.

-- 1. Passed QC — rich data, should index, all sections rendered
INSERT OR REPLACE INTO servers (
  id, name, description, repository_url, package_name, package_type, install_command,
  tool_count, qc_status, qc_tested_at, server_version, capabilities, server_instructions,
  status, source, created_at, updated_at
) VALUES (
  'test-passed-rich',
  '@example/mcp-passed',
  'A fully-tested MCP server for integration testing the per-server detail renderer with rich data including tools, capabilities, and detailed instructions.',
  'https://github.com/example/mcp-passed',
  '@example/mcp-passed',
  'npm',
  'npx -y @example/mcp-passed',
  42,
  'passed',
  '2026-05-09T12:00:00.000Z',
  '1.2.3',
  '{"tools":{"listChanged":true},"resources":{"subscribe":true}}',
  'Use these tools to interact with the example API. Authentication is via env var EXAMPLE_TOKEN. Rate limit: 100 req/min.',
  'active', 'test', '2026-05-09T12:00:00.000Z', '2026-05-09T12:00:00.000Z'
);

-- 2. Failed QC — has description, should still index (failed pages are useful search results)
INSERT OR REPLACE INTO servers (
  id, name, description, repository_url,
  qc_status, qc_error, qc_tested_at,
  status, source, created_at, updated_at
) VALUES (
  'test-failed',
  '@example/mcp-broken',
  'An MCP server that failed quality control checks during installation — useful as a search result for someone evaluating its reliability.',
  'https://github.com/example/mcp-broken',
  'failed',
  'npm install timeout after 60s',
  '2026-05-09T12:00:00.000Z',
  'active', 'test', '2026-05-09T12:00:00.000Z', '2026-05-09T12:00:00.000Z'
);

-- 3. Pending QC with description — index-thin tier
INSERT OR REPLACE INTO servers (
  id, name, description, repository_url,
  qc_status, status, source, created_at, updated_at
) VALUES (
  'test-pending-described',
  '@example/mcp-untested',
  'A queued MCP server awaiting QC verification. Description is real, QC has not run yet.',
  'https://github.com/example/mcp-untested',
  'pending', 'active', 'test', '2026-05-09T12:00:00.000Z', '2026-05-09T12:00:00.000Z'
);

-- 4. Pending QC with empty description — noindex tier
INSERT OR REPLACE INTO servers (
  id, name, description, repository_url,
  qc_status, status, source, created_at, updated_at
) VALUES (
  'test-thin',
  '@example/mcp-thin',
  '',
  'https://github.com/example/mcp-thin',
  'pending', 'active', 'test', '2026-05-09T12:00:00.000Z', '2026-05-09T12:00:00.000Z'
);

-- 5. JSON-LD injection probe — server_instructions contains a literal </script> substring.
-- Verifies safeJsonLd() correctly escapes < to < so the JSON-LD block stays intact.
INSERT OR REPLACE INTO servers (
  id, name, description, repository_url,
  qc_status, qc_tested_at, server_instructions,
  status, source, created_at, updated_at
) VALUES (
  'test-jsonld-injection',
  '@example/mcp-xss-probe',
  'Synthetic test fixture for JSON-LD script-context safety. Server instructions intentionally contain a </script> sequence to exercise safeJsonLd().',
  'https://github.com/example/mcp-xss-probe',
  'passed',
  '2026-05-09T12:00:00.000Z',
  'Step 1: configure auth. </script><img src=x onerror=alert(1)> Step 2: invoke tools.',
  'active', 'test', '2026-05-09T12:00:00.000Z', '2026-05-09T12:00:00.000Z'
);
