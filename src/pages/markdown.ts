// Markdown renderers for content negotiation (Accept: text/markdown).
// Agent-facing markdown variants of the server and category HTML pages, built
// from the same D1 rows the HTML handlers use. The homepage markdown variant
// reuses renderLlmsTxt (already valid markdown) — see the negotiation middleware
// in index.ts. These renderers add NO new behavior to existing HTML routes.

import type { Category } from "../lib/category";

function clean(s: unknown): string {
	return String(s ?? "").trim();
}

export function renderServerMarkdown(server: Record<string, unknown>): string {
	const id = clean(server.id);
	const name = clean(server.name) || id || "MCP server";
	const desc = clean(server.description);
	const out: string[] = [`# ${name}`, ""];
	if (desc) out.push(`> ${desc}`, "");

	const facts: string[] = [];
	if (clean(server.package_type)) facts.push(`- **Package type:** ${clean(server.package_type)}`);
	if (clean(server.install_command)) facts.push(`- **Install:** \`${clean(server.install_command)}\``);
	if (clean(server.qc_status)) facts.push(`- **QC status:** ${clean(server.qc_status)}`);
	if (server.tool_count != null && server.tool_count !== "") facts.push(`- **Tools:** ${clean(server.tool_count)}`);
	if (id) facts.push(`- **ID:** \`${id}\``);
	if (facts.length) out.push("## Details", "", ...facts, "");

	out.push(
		"## Machine-readable",
		"",
		`- Full record (JSON): https://toolidx.dev/v1/servers/${encodeURIComponent(id)}`,
		`- Tool schemas (JSON): https://toolidx.dev/v1/servers/${encodeURIComponent(id)}/tools`,
		`- HTML page: https://toolidx.dev/server/${encodeURIComponent(id)}`,
		"",
	);
	return out.join("\n");
}

export function renderCategoryMarkdown(category: Category, servers: Array<Record<string, unknown>>): string {
	const out: string[] = [`# ${clean(category.displayName)} — MCP servers`, ""];
	if (clean(category.tagline)) out.push(`> ${clean(category.tagline)}`, "");
	out.push(`${servers.length} verified server${servers.length === 1 ? "" : "s"} in this category.`, "");

	for (const s of servers) {
		const id = clean(s.id);
		const name = clean(s.name) || id;
		const desc = clean(s.description);
		out.push(`## ${name}`, "");
		if (desc) out.push(desc, "");
		out.push(`- Detail: https://toolidx.dev/server/${encodeURIComponent(id)}`, "");
	}

	out.push(
		"## Machine-readable",
		"",
		"- Directory API: https://toolidx.dev/v1/servers",
		"- OpenAPI: https://toolidx.dev/openapi.json",
		"",
	);
	return out.join("\n");
}
