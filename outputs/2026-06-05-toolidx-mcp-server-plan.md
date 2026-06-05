# Public toolidx MCP Server With Payment Options

## Summary

Build a small remote MCP server for toolidx.dev at https://toolidx.dev/mcp,
hosted inside the existing Cloudflare Worker, exposing a few agent-native
tools over Streamable HTTP. Keep core discovery free, add one paid premium
tool path, and validate payments in test mode before enabling production
charges.

Use Cloudflare Agents SDK McpAgent rather than a plain REST wrapper because
Cloudflare's current paid MCP tooling is built around withX402 / paidTool,
and this gives a direct upgrade path from free tools to per-call paid tools.

## Key Changes

- Add MCP runtime dependencies:
    - agents
    - @modelcontextprotocol/sdk
    - reuse existing zod

- Add a new ToolidxMcp McpAgent class with route /mcp.
- Add Durable Object binding and migration for ToolidxMcp; run npx wrangler
  types after config changes.

- Keep existing /v1/*, /openapi.json, /llms.txt, and /.well-known/mcp.json
  behavior unchanged.

- Add MCP discovery references:
    - Update /.well-known/mcp.json or add a separate well-known entry only
      if it can honestly describe the live /mcp transport.

    - Add docs text showing remote MCP URL and Claude Desktop proxy example
      using mcp-remote.

## MCP Tool Surface

Expose only decision-oriented tools, not every REST endpoint.

Free tools:

- search_verified_servers
    - Inputs: query, limit, optional filters: package_type,
      requires_env_vars, hangs_on_start, is_proxy.

    - Output: compact ranked server summaries with id, name, description,
      install_command, tool_count, quality_score, qc_status, risk flags.

- get_server_summary
    - Inputs: server_id.
    - Output: slim server profile without full tool schema payload by
      default.

- find_tools
    - Inputs: query, limit.
    - Output: matching tool names/descriptions with server context.

- recommend_servers_for_task
    - Inputs: task, limit, optional prefer_no_env_vars.
    - Output: deterministic heuristic recommendation using current D1
      fields; no LLM dependency in v1.

Paid tool:

- get_install_risk_report
    - Price: test mode $0.01, production price configurable by env var.
    - Inputs: server_id.
    - Output: richer QC-derived report including install timing, schema
      size, env-var requirement, hang/proxy/destructive-tool flags, recent
      QC status, and recommended install posture.

## Payment Design

- Add x402 config via environment variables:
    - X402_ENABLED: false by default.
    - X402_NETWORK: base-sepolia for test, base for production.
    - X402_RECIPIENT: wallet address.
    - X402_FACILITATOR_URL: facilitator URL.
    - MCP_RISK_REPORT_PRICE_USD: default 0.01.

- In local/test mode, register get_install_risk_report as free when
  X402_ENABLED=false.

- In payment test mode, register it with paidTool using base-sepolia.
- Do not require accounts or API keys for free tools.
- Do not gate the whole MCP server initially; gate only premium tools.
- Do not expose bulk export or raw QC history through the public free MCP
  surface.

## Implementation Notes

- Query D1 directly from the MCP handlers using existing tables and the same
  safety filters as REST:
    - public discovery defaults to status='active' and qc_status='passed'.
    - limit all MCP result sets to max 20 unless explicitly changed later.

- Return concise text plus structured JSON content where the MCP SDK
  supports it; agents should not receive huge tool_schemas unless requested
  through a future premium tool.

- Validate Origin for /mcp requests using an allowlist env var, while
  allowing known MCP inspector/local dev origins in development.

- Add structured logging for tool name, success/failure, latency, result
  count, and paid/free mode. Do not log full payment credentials or full
  tool schema bodies.

- Add user-facing docs:
    - MCP endpoint URL.
    - Free vs paid tool list.
    - Payment test status.
    - Example mcp-remote https://toolidx.dev/mcp client config.

## Test Plan

- Unit-test each MCP handler's D1 query behavior with representative rows:
    - verified server returned.
    - failed/pending/rejected server excluded from search.
    - env-var/hang/proxy filters work.
    - limit caps are enforced.
    - unknown server returns a clear MCP error.

- Integration-test /mcp with MCP Inspector or SDK client:
    - initialize succeeds.
    - tool list includes exactly the planned tools.
    - each free tool returns valid content.
    - paid tool is free when X402_ENABLED=false.

- Payment test:
    - enable X402_ENABLED=true with base-sepolia.
    - unpaid premium call returns payment challenge.
    - paid retry returns risk report.
    - invalid payment fails cleanly.

- Regression-test existing surfaces:
    - /v1/status, /v1/servers, /openapi.json, /llms.txt, /.well-known/
      mcp.json still respond as before.

    - npx tsc --noEmit.
    - npx wrangler deploy --dry-run.

- Manual acceptance:
    - Connect from MCP Inspector.
    - Connect from a desktop MCP client through mcp-remote.
    - Ask an agent: "Find an installable MCP server for filesystem/search
      and explain the risk." Confirm it uses toolidx tools without needing
      REST/API knowledge.

## Assumptions

- The first release optimizes for agent adoption, not maximum revenue.
- Public REST remains available.
- Premium value is QC/risk intelligence, not basic directory lookup.
- Production x402 remains disabled until a recipient wallet, facilitator,
  pricing, and payment-support policy are explicitly approved.

- No third-party MCP servers are installed or executed by this MCP server in
  v1; it only recommends and reports on toolidx data.
