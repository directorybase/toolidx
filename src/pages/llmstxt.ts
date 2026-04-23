export function renderLlmsTxt(serverCount: number, lastUpdated: string): string {
	const count = serverCount.toLocaleString("en-US");
	return `# toolidx

> Independent verification and directory service for MCP servers and AI tools. Machine-readable status, evaluation scores, and structured metadata.

toolidx indexes and verifies MCP (Model Context Protocol) servers. Each listing includes a verified description, install command, tool schemas from live QC testing, and multi-model evaluation scores. All data is queryable via REST API.

## Quick Start for Agents

1. GET /v1/servers?status=active&qc_status=passed — list verified, installable servers
2. GET /v1/servers/{id} — full record including tool schemas and scores
3. Use the \`install_command\` field to install the server
4. Check \`tool_schemas\` to understand available tools before integrating

## Endpoints

- [GET /v1/status](https://toolidx.dev/v1/status): Service health and index metadata
- [GET /v1/servers](https://toolidx.dev/v1/servers): List servers — filter by status, qc_status; paginate with limit/offset (max 100)
- [GET /v1/servers/{id}](https://toolidx.dev/v1/servers/{id}): Full server record
- [GET /openapi.json](https://toolidx.dev/openapi.json): OpenAPI 3.1 specification

## Response Envelope

Every response includes \`last_updated\` (ISO 8601 UTC) at the top level so agents can assess data freshness without a separate status call.

## Server Record Fields

- \`id\` — stable slug from repository URL (e.g. github-com-owner-repo-name)
- \`name\` — display name
- \`description\` — AI-generated, quality-gated description
- \`install_command\` — verified install command
- \`package_type\` — npm | uvx | pip
- \`tool_schemas\` — array of tool definitions from live QC install test
- \`tool_count\` — number of tools the server exposes
- \`qc_status\` — pending | passed | failed | error | skipped
- \`quality_score\` — weighted eval score 0–10 (Accuracy 30%, Specificity 25%, Actionability 20%, Trust 15%, Completeness 10%)
- \`sanity_score\` — multi-model consensus score 0–10
- \`status\` — active | pending | rejected

## Verification Pipeline

Each server passes through:
1. AI description generation (multi-model)
2. Sanity Panel cross-review (5 independent agents, divergence flagged)
3. Quality gate (Claude API cold reviewer — approve / revise / reject)
4. QC install test (live npm/uvx/pip install, tool schema introspection)

## Index Stats

- ${count} servers indexed
- Last updated: ${lastUpdated}

## More

- API docs: https://toolidx.dev/docs
- OpenAPI spec: https://toolidx.dev/openapi.json
- Related: https://agenticwatch.dev
`;
}
