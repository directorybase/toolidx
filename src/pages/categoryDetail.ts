// Per-category HTML page renderer (/category/:slug).
// Mirrors landing.ts/serverDetail.ts style: function returning HTML string,
// dark theme, inline CSS, no JS. Spec: plan v3 §5.2 + 2026-05-11 16-category
// taxonomy. Each card shows the most-distinguishing 4 facets from facetsFor.

import type { Category } from "../lib/category";
import { CATEGORIES } from "../lib/category";
import type { Facet } from "../lib/facets";
import { facetsForCard } from "../lib/facets";

type ServerRow = Record<string, unknown>;

function esc(s: string | null | undefined): string {
	if (s == null) return "";
	return String(s).replace(/[&<>"']/g, ch => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!
	));
}
function safeJsonLd(obj: unknown): string {
	return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
}
function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 1).trimEnd() + "…";
}

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f0f0f; --surface: #1a1a1a; --border: #2a2a2a;
  --text: #f0f0f0; --muted: #737373;
  --green: #16a34a; --green-lt: #4ade80;
  --red: #ef4444; --amber: #f59e0b; --blue: #60a5fa;
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
  flex: 1; max-width: 1100px; width: 100%; margin: 0 auto;
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
  color: var(--text); margin-bottom: 12px;
}
.tagline {
  font-size: 17px; color: var(--muted); margin-bottom: 8px; max-width: 720px;
}
.summary-meta {
  font-family: var(--mono); font-size: 13px; color: var(--muted);
  margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid var(--border);
}
.empty {
  font-size: 15px; color: var(--muted); padding: 40px 0; text-align: center;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.card { background: var(--surface); display: block; padding: 18px 20px; text-decoration: none; color: var(--text); transition: background 0.15s; }
.card:hover { background: #222; }
.card-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.card-name { font-family: var(--mono); font-size: 14px; font-weight: 600; color: var(--green-lt); word-break: break-word; }
.card-status { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; flex-shrink: 0; }
.status-passed { background: rgba(22, 163, 74, 0.15); color: var(--green-lt); border: 1px solid rgba(22, 163, 74, 0.4); }
.status-failed { background: rgba(239, 68, 68, 0.15); color: var(--red); border: 1px solid rgba(239, 68, 68, 0.4); }
.status-pending { background: rgba(245, 158, 11, 0.15); color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.4); }
.card-desc { font-size: 13px; color: var(--text); margin-bottom: 10px; line-height: 1.5; }
.facet-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.facet { display: inline-block; font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 7px; border-radius: 3px; border: 1px solid; }
.facet-good    { background: rgba(22, 163, 74, 0.10); color: var(--green-lt); border-color: rgba(22, 163, 74, 0.30); }
.facet-warn    { background: rgba(245, 158, 11, 0.10); color: var(--amber);    border-color: rgba(245, 158, 11, 0.30); }
.facet-bad     { background: rgba(239, 68, 68, 0.10);  color: var(--red);      border-color: rgba(239, 68, 68, 0.30); }
.facet-info    { background: rgba(96, 165, 250, 0.10); color: var(--blue);     border-color: rgba(96, 165, 250, 0.30); }
.facet-neutral { background: rgba(115, 115, 115, 0.15); color: var(--muted);   border-color: rgba(115, 115, 115, 0.40); }
footer {
  padding: 24px 40px; border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; color: var(--muted);
}
.footer-links { display: flex; gap: 24px; list-style: none; }
.footer-links a { color: var(--muted); text-decoration: none; font-family: var(--mono); font-size: 11px; }
.footer-links a:hover { color: var(--text); }
@media (max-width: 700px) {
  nav { padding: 16px 20px; }
  .nav-links { gap: 16px; }
  main { padding: 32px 20px 48px; }
  .card-grid { grid-template-columns: 1fr; }
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

function renderFacetStrip(facets: Facet[]): string {
	if (!facets.length) return "";
	return `<div class="facet-strip">${facets.map(f =>
		`<span class="facet facet-${f.variant}"${f.title ? ` title="${esc(f.title)}"` : ""}>${esc(f.label)}</span>`
	).join("")}</div>`;
}

function renderCard(server: ServerRow): string {
	const id = String(server.id ?? "");
	const name = String(server.name ?? id);
	const description = (server.description as string | null) ?? "";
	const qcStatus = String(server.qc_status ?? "pending");
	const statusClass = qcStatus === "passed" ? "status-passed"
		: qcStatus === "failed" || qcStatus === "error" ? "status-failed"
		: "status-pending";
	const statusLabel = qcStatus === "passed" ? "VERIFIED"
		: qcStatus === "failed" ? "FAILED"
		: qcStatus === "error" ? "ERROR"
		: "PENDING";
	const facets = facetsForCard(server);
	const desc = description.trim().length > 0
		? truncate(description.trim(), 160)
		: "(no description provided)";
	return `<a class="card" href="/server/${encodeURIComponent(id)}">
  <div class="card-header">
    <span class="card-name">${esc(name)}</span>
    <span class="card-status ${statusClass}">${esc(statusLabel)}</span>
  </div>
  <div class="card-desc">${esc(desc)}</div>
  ${renderFacetStrip(facets)}
</a>`;
}

export function renderCategoryDetail(category: Category, servers: ServerRow[]): string {
	const canonical = `https://toolidx.dev/category/${encodeURIComponent(category.slug)}`;
	const title = `${category.displayName} MCP servers — toolidx`;
	const metaDescription = `${category.tagline} ${servers.length} verified MCP servers in this category, scored on install, runtime, and tool safety.`;

	const breadcrumbLd = {
		"@context": "https://schema.org",
		"@type": "BreadcrumbList",
		itemListElement: [
			{ "@type": "ListItem", position: 1, name: "toolidx", item: "https://toolidx.dev/" },
			{ "@type": "ListItem", position: 2, name: category.displayName, item: canonical },
		],
	};

	const itemListLd = {
		"@context": "https://schema.org",
		"@type": "ItemList",
		name: `${category.displayName} MCP servers`,
		description: category.tagline,
		numberOfItems: servers.length,
		itemListElement: servers.slice(0, 50).map((s, i) => ({
			"@type": "ListItem",
			position: i + 1,
			url: `https://toolidx.dev/server/${encodeURIComponent(String(s.id))}`,
			name: String(s.name ?? s.id),
		})),
	};

	const grid = servers.length > 0
		? `<div class="card-grid">${servers.map(renderCard).join("\n")}</div>`
		: `<p class="empty">No MCP servers verified in this category yet. Check back soon, or browse another category from the homepage.</p>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(metaDescription)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${esc(canonical)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="toolidx">
  <meta property="og:title" content="${esc(category.displayName)} MCP servers — toolidx">
  <meta property="og:description" content="${esc(category.tagline)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="https://toolidx.dev/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(category.displayName)} MCP servers — toolidx">
  <meta name="twitter:description" content="${esc(category.tagline)}">
  <meta name="twitter:image" content="https://toolidx.dev/og.png">
  <script type="application/ld+json">${safeJsonLd(itemListLd)}</script>
  <script type="application/ld+json">${safeJsonLd(breadcrumbLd)}</script>
  <style>${CSS}</style>
</head>
<body>
${NAV}
<main>
  <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">toolidx</a> &nbsp;›&nbsp; <span>category / ${esc(category.slug)}</span></nav>
  <h1>${esc(category.displayName)}</h1>
  <p class="tagline">${esc(category.tagline)}</p>
  <p class="summary-meta">${servers.length.toLocaleString("en-US")} servers — verified by runtime behavior, not README tags.</p>
  ${grid}
</main>
${FOOTER}
</body>
</html>`;
}

export function renderCategoryNotFound(slug: string): string {
	const safeSlug = esc(slug);
	const list = CATEGORIES.map(c => `<li><a href="/category/${encodeURIComponent(c.slug)}" style="color:var(--green-lt);text-decoration:none">${esc(c.displayName)}</a></li>`).join("\n");
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Category not found — toolidx</title>
  <meta name="robots" content="noindex, follow">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>${CSS}</style>
</head>
<body>
${NAV}
<main>
  <h1>Category not found</h1>
  <p class="tagline">No category with slug <code>${safeSlug}</code>. Available categories:</p>
  <ul style="list-style:none;padding:0;margin-top:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">${list}</ul>
  <p style="margin-top:32px"><a href="/" style="color:var(--green-lt)">← Back to toolidx</a></p>
</main>
${FOOTER}
</body>
</html>`;
}
