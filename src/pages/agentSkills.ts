// Agent Skills Discovery — Cloudflare RFC v0.2.0.
// toolidx publishes ONE honest skill: a real SKILL.md teaching an agent to
// search the verified MCP-server directory via the REST API. The discovery
// index at /.well-known/agent-skills/index.json points at that SKILL.md and
// carries a sha256 digest of its EXACT served bytes, computed at runtime
// (sha256Hex) so the digest can never drift from the file.
//
// Spec notes (v0.2.0):
//  - type MUST be "skill-md" or "archive" (we use skill-md).
//  - url MUST resolve to the SKILL.md artifact itself (not the REST API).
//  - digest = "sha256:" + lowercase-hex(SHA-256(raw bytes served at url)).
//  - index description SHOULD match the SKILL.md frontmatter description.

const SKILL_DESCRIPTION =
	"Search the toolidx directory of verified MCP servers by name, capability, or keyword via the REST API, and retrieve install commands, tool schemas, and verification status.";

export const SEARCH_SKILL_URL =
	"https://toolidx.dev/.well-known/agent-skills/search-mcp-servers/SKILL.md";

// The literal bytes served at SEARCH_SKILL_URL. The digest in the index is
// computed over this exact string at request time — keep them coupled.
export const SEARCH_SKILL_MD = `---
name: search-mcp-servers
description: ${SKILL_DESCRIPTION}
---

# Search MCP servers (toolidx)

toolidx is an independent directory that verifies MCP (Model Context Protocol)
servers: each listing has a quality-gated description, a real install command, and
tool schemas captured from a live install test. All data is queryable over a public
REST API — no authentication required.

## When to use this skill

Use it to discover and vet MCP servers before installing them: "find an MCP server
for Postgres", "which verified servers expose a search tool", "what's the install
command and tool list for server X".

## Steps

1. **List verified servers**

   GET https://toolidx.dev/v1/servers?status=active&qc_status=passed

   Filters: status, qc_status, is_proxy, hangs_on_start, requires_env_vars,
   qc_platform. Paginate with ?limit=N&page=N (limit max 100, page is 1-indexed).

2. **Search tools across all servers**

   GET https://toolidx.dev/v1/tools?q=<keyword>

3. **Fetch a full server record** (description, install_command, tool_schemas,
   capabilities, verification status)

   GET https://toolidx.dev/v1/servers/{id}

4. **Install** using the verified \`install_command\` field, then inspect
   \`tool_schemas\` to understand the available tools before integrating.

## Response notes

Every JSON response includes a top-level \`last_updated\` (ISO 8601 UTC) so you can
judge data freshness without a separate status call. Server \`id\` is a stable slug
derived from the repository URL (e.g. github-com-owner-repo-name).

## Reference

- OpenAPI spec: https://toolidx.dev/openapi.json
- Plain-text guide: https://toolidx.dev/llms.txt
- Service status: https://toolidx.dev/v1/status
`;

// SHA-256 → lowercase hex, via Web Crypto (available in Workers).
export async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Build the discovery index with a live digest of SEARCH_SKILL_MD.
export async function buildAgentSkillsIndex(): Promise<Record<string, unknown>> {
	const digest = await sha256Hex(SEARCH_SKILL_MD);
	return {
		$schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
		skills: [
			{
				name: "search-mcp-servers",
				type: "skill-md",
				description: SKILL_DESCRIPTION,
				url: SEARCH_SKILL_URL,
				digest: `sha256:${digest}`,
			},
		],
	};
}
