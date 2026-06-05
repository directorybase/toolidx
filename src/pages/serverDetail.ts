// Per-server HTML detail page renderer.
// Spec: outputs/2026-05-09-claude-toolidx-per-server-pages-plan-v3.md §3.1–§3.4
// Phase 3 addition (2026-05-11): facet strip below status badge.
// Sanity Panel addition (2026-05-11): review block per v5 §3.5.
// Sanity Panel v6 IA refactor (2026-05-12): composite description replaces
// page summary; consensus + dissent moves up; per-agent panels show insights
// only. Spec: outputs/2026-05-12-claude-toolidx-multi-agent-review-surface-plan-v6.md §3.5

import { facetsFor, type Facet } from "../lib/facets";
import { classify } from "../lib/category";
import type { Composite } from "../lib/composite";

type ServerRow = Record<string, unknown>;

export type EvalRowForRender = {
	agent: string;
	model: string;
	lens: string;
	pass: number;
	notes: string | null;
	description: string | null;
	created_at: string;
};

// v11 §4: coverage replaces the score/verdict aggregate (the panel emits
// neither). agents_total is the literal 5-agent panel size.
export type EvalsCoverage = {
	agents_with_pass3: number;
	agents_total: number;
	passes_present: number[];
};

export type EvalsBundle = {
	rows: EvalRowForRender[];
	coverage: EvalsCoverage;
};

// HTML-escape for attribute/text contexts ONLY. Never use for JSON-LD <script> bodies.
function esc(s: string | null | undefined): string {
	if (s == null) return "";
	return String(s).replace(/[&<>"']/g, ch => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!
	));
}

// JSON-LD script-body safety: JSON.stringify is the encoder; the two replacers
// neutralize the only sequences that could break out of <script type="application/ld+json">
// or an enclosing HTML comment. JSON parsers accept < / >.
function safeJsonLd(obj: unknown): string {
	return JSON.stringify(obj)
		.replace(/</g, "\\u003c")
		.replace(/-->/g, "--\\u003e");
}

// URL-safe + HTML-attribute-safe canonical URL builder. URL-encoding handles
// any future ID schema change (e.g., '&', '?', '/'); HTML-escape handles attribute context.
function canonicalFor(id: string): string {
	return `https://toolidx.dev/server/${encodeURIComponent(id)}`;
}

type Tier = "index" | "index-thin" | "noindex";
type Badge = { label: string; cls: string };

function indexabilityTier(qcStatus: string, description: string | null | undefined): Tier {
	const descLen = (description ?? "").trim().length;
	if (descLen < 20) return "noindex";
	if (qcStatus === "passed" || qcStatus === "failed") return "index";
	return "index-thin"; // pending with description
}

function badgeFor(qcStatus: string): Badge {
	switch (qcStatus) {
		case "passed": return { label: "VERIFIED", cls: "badge-passed" };
		case "failed": return { label: "FAILED", cls: "badge-failed" };
		case "error":  return { label: "ERROR", cls: "badge-failed" };
		case "skipped": return { label: "SKIPPED", cls: "badge-pending" };
		default: return { label: "PENDING", cls: "badge-pending" };
	}
}

function parseJson<T>(raw: unknown): T | null {
	if (raw == null) return null;
	if (typeof raw !== "string") return raw as T;
	try { return JSON.parse(raw) as T; } catch { return null; }
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 1).trimEnd() + "…";
}

function safeRepoLink(url: string | null | undefined): string | null {
	if (!url) return null;
	const trimmed = url.replace(/^git\+/, "");
	if (!/^https?:\/\//.test(trimmed)) return null;
	return trimmed;
}

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f0f0f; --surface: #1a1a1a; --border: #2a2a2a;
  --text: #f0f0f0; --muted: #737373;
  --green: #16a34a; --green-lt: #4ade80;
  --red: #ef4444; --amber: #f59e0b;
  --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--text); font-family: var(--sans);
  font-size: 16px; line-height: 1.6;
  min-height: 100vh; display: flex; flex-direction: column;
}
nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 40px; border-bottom: 1px solid var(--border);
}
.nav-logo {
  display: flex; align-items: center; gap: 10px;
  text-decoration: none; color: var(--text);
  font-family: var(--mono); font-size: 15px; font-weight: 600; letter-spacing: -0.02em;
}
.nav-links { display: flex; gap: 28px; list-style: none; }
.nav-links a {
  color: var(--muted); text-decoration: none; font-size: 13px;
  letter-spacing: 0.02em; transition: color 0.15s;
}
.nav-links a:hover { color: var(--text); }
main {
  flex: 1; max-width: 880px; width: 100%; margin: 0 auto;
  padding: 56px 40px 80px;
}
.breadcrumb {
  font-family: var(--mono); font-size: 13px; color: var(--muted);
  margin-bottom: 24px;
}
.breadcrumb a { color: var(--green-lt); text-decoration: none; }
.breadcrumb a:hover { text-decoration: underline; }
h1 {
  font-size: clamp(28px, 4vw, 40px); font-weight: 700; letter-spacing: -0.03em;
  color: var(--text); margin-bottom: 12px; word-break: break-word;
}
.summary {
  font-size: 17px; color: var(--text); margin-bottom: 24px; max-width: 720px;
}
.summary.empty { color: var(--muted); font-style: italic; }
.status-row {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  margin-bottom: 40px; padding-bottom: 24px; border-bottom: 1px solid var(--border);
}
.badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 5px;
  font-family: var(--mono); font-size: 11px; font-weight: 600;
  letter-spacing: 0.05em; text-transform: uppercase;
}
.badge-passed { background: rgba(22, 163, 74, 0.15); color: var(--green-lt); border: 1px solid rgba(22, 163, 74, 0.4); }
.badge-failed { background: rgba(239, 68, 68, 0.15); color: var(--red); border: 1px solid rgba(239, 68, 68, 0.4); }
.badge-pending { background: rgba(245, 158, 11, 0.15); color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.4); }
.meta { font-family: var(--mono); font-size: 13px; color: var(--muted); }
.meta-sep { margin: 0 8px; color: var(--border); }
.facet-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; }
.facet { display: inline-block; font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; padding: 3px 8px; border-radius: 3px; border: 1px solid; }
.facet-good    { background: rgba(22, 163, 74, 0.10); color: var(--green-lt); border-color: rgba(22, 163, 74, 0.30); }
.facet-warn    { background: rgba(245, 158, 11, 0.10); color: var(--amber);    border-color: rgba(245, 158, 11, 0.30); }
.facet-bad     { background: rgba(239, 68, 68, 0.10);  color: var(--red);      border-color: rgba(239, 68, 68, 0.30); }
.facet-info    { background: rgba(96, 165, 250, 0.10); color: #60a5fa;         border-color: rgba(96, 165, 250, 0.30); }
.facet-neutral { background: rgba(115, 115, 115, 0.15); color: var(--muted);   border-color: rgba(115, 115, 115, 0.40); }
.category-link { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-top: 12px; }
.category-link a { color: var(--green-lt); text-decoration: none; }
.category-link a:hover { text-decoration: underline; }
section { margin-bottom: 40px; }
h2 {
  font-size: 18px; font-weight: 600; color: var(--text);
  margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid var(--border);
}
pre {
  background: var(--surface); border: 1px solid var(--border); border-radius: 7px;
  padding: 16px 20px; overflow-x: auto;
  font-family: var(--mono); font-size: 14px; line-height: 1.5;
  color: var(--green-lt);
}
.cap-list, .links-list { list-style: none; }
.cap-list li, .links-list li { padding: 6px 0; font-family: var(--mono); font-size: 14px; }
.cap-list li::before { content: '✓'; color: var(--green-lt); margin-right: 10px; }
.links-list a { color: var(--green-lt); text-decoration: none; }
.links-list a:hover { text-decoration: underline; }
.instructions { color: var(--text); white-space: pre-wrap; max-width: 760px; }
/* Composite provenance line (v11 §3.5) — sits between page summary and
   status-row. One plain attribution line. No consensus badge, no concerns
   disclosure (the panel emits no score/verdict — those surfaces are deleted). */
.composite-meta-block { background: rgba(74, 222, 128, 0.04); border: 1px solid rgba(74, 222, 128, 0.20); border-left: 3px solid var(--green-lt); border-radius: 5px; padding: 12px 18px; margin-bottom: 20px; }
.composite-provenance { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.composite-provenance strong { color: var(--text); font-weight: 600; }
.composite-model { color: var(--green-lt); font-family: var(--mono); }
/* Sanity Panel review block (v11 §3.5) — coverage line + per-agent <details>.
   Per-agent body = Pass-3 description; a blind→informed evolution disclosure
   when both a Pass-1 and a Pass-3 row exist for that (server, agent). */
.review-headline { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 16px; font-family: var(--mono); font-size: 12px; color: var(--muted); }
.review-coverage { color: var(--text); font-weight: 600; }
.review-agents details { border: 1px solid var(--border); border-radius: 5px; padding: 10px 14px; margin-bottom: 8px; background: var(--surface); }
.review-agents details > summary { cursor: pointer; font-family: var(--mono); font-size: 13px; color: var(--text); list-style: none; }
.review-agents details > summary::-webkit-details-marker { display: none; }
.review-agents details > summary::before { content: '▸'; margin-right: 8px; color: var(--muted); transition: transform 0.15s; display: inline-block; }
.review-agents details[open] > summary::before { transform: rotate(90deg); }
/* Per-pass description renders untruncated — these ARE the insights agents read. */
.review-finding { color: var(--text); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-width: 620px; margin-top: 10px; }
.desc-evolution { margin-top: 10px; }
.desc-evolution > summary { cursor: pointer; font-family: var(--mono); font-size: 11px; color: var(--muted); list-style: none; }
.desc-evolution > summary::-webkit-details-marker { display: none; }
.desc-evolution > summary::before { content: '↳ '; color: var(--muted); }
.desc-evolution .desc-pass1, .desc-evolution .desc-pass3 { margin-top: 8px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-width: 620px; }
.desc-evolution .desc-pass1 { color: var(--muted); }
.desc-evolution .desc-pass3 { color: var(--text); }
.desc-evolution .desc-label { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); display: block; margin-top: 8px; }
footer {
  padding: 24px 40px; border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; color: var(--muted);
}
.footer-links { display: flex; gap: 24px; list-style: none; }
.footer-links a {
  color: var(--muted); text-decoration: none;
  font-family: var(--mono); font-size: 11px;
}
.footer-links a:hover { color: var(--text); }
@media (max-width: 600px) {
  nav { padding: 16px 20px; }
  .nav-links { gap: 16px; }
  main { padding: 32px 20px 48px; }
  footer { flex-direction: column; gap: 16px; text-align: center; }
}
`;

const NAV = `
<nav>
  <a class="nav-logo" href="/">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="24" height="24">
      <rect width="64" height="64" rx="12" fill="#111111"/>
      <rect x="12" y="14" width="30" height="6" rx="3" fill="#FFFFFF"/>
      <rect x="12" y="27" width="30" height="6" rx="3" fill="#FFFFFF"/>
      <rect x="12" y="40" width="22" height="6" rx="3" fill="#FFFFFF"/>
      <circle cx="48" cy="48" r="8" fill="#16A34A"/>
    </svg>
    toolidx.dev
  </a>
  <ul class="nav-links">
    <li><a href="/docs">API Docs</a></li>
    <li><a href="/openapi.json">OpenAPI</a></li>
    <li><a href="https://agenticwatch.dev">AgenticWatch</a></li>
    <li><a href="https://github.com/directorybase/toolidx">GitHub</a></li>
  </ul>
</nav>`;

const FOOTER = `
<footer>
  <span>toolidx.dev — independent MCP verification</span>
  <ul class="footer-links">
    <li><a href="/docs">API Docs</a></li>
    <li><a href="/openapi.json">OpenAPI</a></li>
    <li><a href="/llms.txt">llms.txt</a></li>
    <li><a href="/.well-known/mcp.json">mcp.json</a></li>
    <li><a href="https://agenticwatch.dev">AgenticWatch</a></li>
  </ul>
</footer>`;

// Sanity Panel review block — coverage line + per-agent <details> drill-in.
// Spec: outputs/2026-05-15-claude-toolidx-multi-agent-review-surface-plan-v11.md §3.5
// v11 (the panel emits no score/verdict at any pass — verified live):
//   - No mean/spread/verdict headline. A coverage line states how much of the
//     5-agent panel landed (agents_with_pass3 / 5 · passes present).
//   - Per-agent <details>: body = Pass-3 description (Pass-1 if no Pass-3).
//   - When BOTH a Pass-1 and a Pass-3 row exist for that (server, agent), a
//     <details class="desc-evolution"> blind→informed disclosure shows the
//     Pass-1 row's description (.desc-pass1) and the Pass-3 row's (.desc-pass3).
//     .desc-pass1 is sourced from the Pass-1 evals row — the row model's single
//     source of truth — never pass3.json.pass1_description.
//   - No score/verdict columns anywhere.
// Empty-state: agents_with_pass3 === 0 → "" so the block is omitted from the DOM.
function renderReviewSection(evals: EvalsBundle | null): string {
	if (!evals || evals.coverage.agents_with_pass3 === 0) return "";
	const { coverage, rows } = evals;

	// Group rows by agent for the drill-in.
	const byAgent = new Map<string, EvalRowForRender[]>();
	for (const r of rows) {
		const arr = byAgent.get(r.agent) ?? [];
		arr.push(r);
		byAgent.set(r.agent, arr);
	}
	const agentKeys = Array.from(byAgent.keys()).sort();

	const passesLabel = coverage.passes_present.length
		? `passes ${coverage.passes_present.join(", ")}`
		: "no passes";

	const agentBlocks = agentKeys.map(agent => {
		const agentRows = byAgent.get(agent) ?? [];
		const pass1 = agentRows.find(r => r.pass === 1) ?? null;
		const pass3 = agentRows.find(r => r.pass === 3) ?? null;
		const primary = pass3 ?? pass1;
		const model = primary?.model ?? "";
		// One agent owns one lens — surface it in the summary line.
		const lens = primary?.lens ?? "";
		const primaryDesc = (primary?.description ?? "").trim();
		const bodyHtml = primaryDesc
			? `<div class="review-finding">${esc(primaryDesc)}</div>`
			: `<div class="review-finding">—</div>`;

		// Blind→informed evolution: only when BOTH a Pass-1 AND a Pass-3 row
		// exist for this (server, agent). .desc-pass1 = the Pass-1 row's own
		// description (single source of truth, v11 §3.5).
		const p1Desc = (pass1?.description ?? "").trim();
		const p3Desc = (pass3?.description ?? "").trim();
		const evolutionHtml = pass1 && pass3
			? `<details class="desc-evolution">
        <summary>blind → informed</summary>
        <span class="desc-label">pass 1 — blind</span>
        <div class="desc-pass1">${esc(p1Desc || "—")}</div>
        <span class="desc-label">pass 3 — informed</span>
        <div class="desc-pass3">${esc(p3Desc || "—")}</div>
      </details>`
			: "";

		const summaryParts = [
			`agent ${esc(agent)}`,
			model ? `<span class="meta">· ${esc(model)}</span>` : "",
			lens ? `<span class="meta">· ${esc(lens)} lens</span>` : "",
		].filter(Boolean).join(" ");
		return `<details>
      <summary>${summaryParts}</summary>
      ${bodyHtml}
      ${evolutionHtml}
    </details>`;
	}).join("\n");

	return `<section id="evals-block">
    <h2>5-agent Sanity Panel — per-lens findings</h2>
    <div class="review-headline">
      <span class="review-coverage">${coverage.agents_with_pass3} of ${coverage.agents_total} agents</span>
      <span>·</span>
      <span>${passesLabel}</span>
    </div>
    <div class="review-agents">${agentBlocks}</div>
  </section>`;
}

// Composite provenance line (v11 §3.5) — sits between page summary and
// status-row. One plain attribution line, rendered whenever a composite is
// present. NO consensus badge, NO concerns disclosure (the panel emits no
// score/verdict — those surfaces are deleted).
function renderCompositeMeta(composite: Composite | null): string {
	if (!composite) return "";
	const isOverride = composite.source.agent === "operator";

	const provenance = isOverride
		? `<span class="composite-provenance">generated by <strong>operator-curated</strong></span>`
		: `<span class="composite-provenance">generated by <strong>agent ${esc(composite.source.agent)}</strong> · ${esc(composite.source.lens)} lens${
			composite.source.model ? ` · <span class="composite-model">${esc(composite.source.model)}</span>` : ""
		}</span>`;

	return `<div class="composite-meta-block">
    ${provenance}
  </div>`;
}

export function renderServerDetail(
	server: ServerRow,
	evals: EvalsBundle | null = null,
	summary: string | null = null,
	composite: Composite | null = null,
): string {
	const id = String(server.id ?? "");
	const name = String(server.name ?? id);
	const description = (server.description as string | null) ?? "";
	// v6 §3.5 Delta 1: summary text source is the composite when available,
	// else server.description (single-agent fallback). Caller is responsible
	// for that pick; renderer just uses what it's given. Backwards-compatible
	// default: no caller-supplied summary → use server.description.
	const summaryText = (summary ?? description).trim();
	const qcStatus = String(server.qc_status ?? "pending");
	const installCommand = (server.install_command as string | null) ?? null;
	const toolCount = (server.tool_count as number | null) ?? null;
	const packageType = (server.package_type as string | null) ?? null;
	const serverVersion = (server.server_version as string | null) ?? null;
	const npmVersion = (server.npm_version as string | null) ?? null;
	const repositoryUrl = (server.repository_url as string | null) ?? null;
	const serverInstructions = (server.server_instructions as string | null) ?? null;
	const capabilities = parseJson<Record<string, unknown>>(server.capabilities);

	const tier = indexabilityTier(qcStatus, description);
	const badge = badgeFor(qcStatus);
	const canonical = canonicalFor(id);
	const repoLink = safeRepoLink(repositoryUrl);
	const facets: Facet[] = facetsFor(server);
	const category = classify(name, description);

	const robots = tier === "noindex" ? "noindex, follow" : "index, follow";
	const title = `${name} — MCP server | toolidx`;
	const metaDescription = description.trim().length >= 20
		? truncate(description.trim(), 155)
		: `MCP server entry for ${name} on toolidx — verified MCP server directory.`;
	const ogDescription = description.trim().length >= 20
		? truncate(description.trim(), 200)
		: metaDescription;
	const versionLabel = serverVersion ?? npmVersion ?? null;

	// JSON-LD: build objects in JS, serialize with safeJsonLd. NEVER esc() these.
	const ld: Record<string, unknown> = {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name,
		url: canonical,
		applicationCategory: "DeveloperApplication",
		applicationSubCategory: "MCP Server",
		operatingSystem: "Cross-platform",
		softwareRequirements: "Model Context Protocol client",
		isAccessibleForFree: true,
		offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
	};
	if (description.trim().length > 0) ld.description = description.trim();
	if (repoLink) ld.codeRepository = repoLink;
	if (versionLabel) ld.softwareVersion = versionLabel;

	// BreadcrumbList — eligible for site-link breadcrumb rich results in SERP.
	const breadcrumb = {
		"@context": "https://schema.org",
		"@type": "BreadcrumbList",
		itemListElement: [
			{ "@type": "ListItem", position: 1, name: "toolidx", item: "https://toolidx.dev/" },
			{ "@type": "ListItem", position: 2, name, item: canonical },
		],
	};

	// Capabilities list — show only when we have something meaningful
	const capItems: string[] = [];
	if (capabilities && typeof capabilities === "object") {
		for (const key of Object.keys(capabilities)) {
			capItems.push(esc(key));
		}
	}

	const metaLineParts: string[] = [];
	if (toolCount != null) metaLineParts.push(`${toolCount} tools`);
	if (packageType) metaLineParts.push(esc(packageType));
	if (versionLabel) metaLineParts.push(`v${esc(versionLabel)}`);
	const metaLineHtml = metaLineParts.length
		? metaLineParts.join(`<span class="meta-sep">·</span>`)
		: "";

	// v6 §3.5 Delta 1: <p class="summary"> renders summaryText (composite when
	// available, server.description otherwise). The single-agent fallback path
	// is preserved when neither is present.
	const summaryHtml = summaryText.length > 0
		? `<p class="summary">${esc(summaryText)}</p>`
		: `<p class="summary empty">No description provided.</p>`;
	const compositeMetaHtml = renderCompositeMeta(composite);

	const installSection = installCommand
		? `<section id="install">
    <h2>Install</h2>
    <pre><code>${esc(installCommand)}</code></pre>
  </section>`
		: "";

	const capabilitiesSection = capItems.length
		? `<section id="capabilities">
    <h2>Capabilities</h2>
    <ul class="cap-list">${capItems.map(c => `<li>${c}</li>`).join("")}</ul>
  </section>`
		: "";

	const instructionsSection = (serverInstructions && serverInstructions.trim().length > 0)
		? `<section id="instructions">
    <h2>Server instructions</h2>
    <p class="instructions">${esc(serverInstructions.trim())}</p>
  </section>`
		: "";

	const reviewSection = renderReviewSection(evals);

	const linksList: string[] = [];
	if (repoLink) linksList.push(`<li><a href="${esc(repoLink)}" rel="nofollow noopener" target="_blank">Repository ↗</a></li>`);
	linksList.push(`<li><a href="/v1/servers/${encodeURIComponent(id)}">JSON record</a> <span class="meta">(API)</span></li>`);
	linksList.push(`<li><a href="/v1/servers/${encodeURIComponent(id)}/tools">Tool schemas</a> <span class="meta">(API)</span></li>`);
	if (evals && evals.coverage.agents_with_pass3 >= 1) {
		linksList.push(`<li><a href="/v1/servers/${encodeURIComponent(id)}/evals">Panel evals</a> <span class="meta">(API)</span></li>`);
	}

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(metaDescription)}">
  <meta name="robots" content="${robots}">
  <link rel="canonical" href="${esc(canonical)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="toolidx">
  <meta property="og:title" content="${esc(name)} — MCP server">
  <meta property="og:description" content="${esc(ogDescription)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="https://toolidx.dev/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(name)} — MCP server">
  <meta name="twitter:description" content="${esc(ogDescription)}">
  <meta name="twitter:image" content="https://toolidx.dev/og.png">
  <script type="application/ld+json">${safeJsonLd(ld)}</script>
  <script type="application/ld+json">${safeJsonLd(breadcrumb)}</script>
  <style>${CSS}</style>
</head>
<body>
${NAV}
<main>
  <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">toolidx</a> &nbsp;›&nbsp; <span>/server/${esc(id)}</span></nav>
  <h1>${esc(name)}</h1>
  ${summaryHtml}
  ${compositeMetaHtml}
  <div class="status-row">
    <span class="badge ${badge.cls}">${esc(badge.label)}</span>
    ${metaLineHtml ? `<span class="meta">${metaLineHtml}</span>` : ""}
  </div>
  ${facets.length > 0 ? `<div class="facet-strip">${facets.map(f =>
    `<span class="facet facet-${f.variant}"${f.title ? ` title="${esc(f.title)}"` : ""}>${esc(f.label)}</span>`
  ).join("")}</div>` : ""}
  <p class="category-link">Category: <a href="/category/${encodeURIComponent(category.slug)}">${esc(category.displayName)}</a></p>
  ${installSection}
  ${capabilitiesSection}
  ${instructionsSection}
  ${reviewSection}
  <section id="links">
    <h2>Links</h2>
    <ul class="links-list">
${linksList.join("\n")}
    </ul>
  </section>
</main>
${FOOTER}
</body>
</html>`;
}

export function renderServerNotFound(id: string): string {
	const safeId = esc(id);
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Server not found — toolidx</title>
  <meta name="robots" content="noindex, follow">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>${CSS}</style>
</head>
<body>
${NAV}
<main>
  <h1>Server not found</h1>
  <p class="summary">No server with id <code>${safeId}</code> exists in the toolidx catalog. It may have been removed, or the URL may be mistyped.</p>
  <p><a href="/" style="color:var(--green-lt)">← Back to toolidx</a></p>
</main>
${FOOTER}
</body>
</html>`;
}
