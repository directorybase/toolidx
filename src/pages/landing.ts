type RecentServer = { id: string; name: string; description: string };
type CategorySummary = { slug: string; displayName: string; tagline: string; count: number };

// HTML-escape for attribute/text contexts. Mirrors serverDetail.ts esc().
function escHtml(s: string | null | undefined): string {
	if (s == null) return "";
	return String(s).replace(/[&<>"']/g, ch => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!
	));
}
function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 1).trimEnd() + "…";
}
// JSON-LD script-body safety. Mirrors serverDetail.ts safeJsonLd().
function safeJsonLd(obj: unknown): string {
	return JSON.stringify(obj)
		.replace(/</g, "\\u003c")
		.replace(/-->/g, "--\\u003e");
}

export function renderLanding(
	serverCount: number,
	lastUpdated: string,
	recentServers: RecentServer[] = [],
	categories: CategorySummary[] = [],
): string {
	const formatted = lastUpdated
		? new Date(lastUpdated).toLocaleString("en-US", {
				month: "short", day: "numeric", year: "numeric",
				hour: "2-digit", minute: "2-digit",
				timeZone: "UTC", timeZoneName: "short",
		  })
		: "—";

	const count = serverCount.toLocaleString("en-US");

	const recentSection = recentServers.length > 0
		? `<section class="recent">
    <h2>Recently verified</h2>
    <ul class="recent-list">
      ${recentServers.map(s => `<li>
        <a href="/server/${encodeURIComponent(s.id)}">
          <span class="recent-name">${escHtml(s.name)}</span>
          <span class="recent-desc">${escHtml(truncate((s.description ?? "").trim(), 110))}</span>
        </a>
      </li>`).join("\n      ")}
    </ul>
  </section>`
		: "";

	// ItemList JSON-LD for the Recently verified section. Eligible for carousel
	// rich results. Only emit when we have items to list — empty ItemList is
	// noise to crawlers.
	const itemListLd = recentServers.length > 0
		? safeJsonLd({
			"@context": "https://schema.org",
			"@type": "ItemList",
			name: "Recently verified MCP servers",
			itemListOrder: "https://schema.org/ItemListOrderDescending",
			numberOfItems: recentServers.length,
			itemListElement: recentServers.map((s, i) => ({
				"@type": "ListItem",
				position: i + 1,
				url: `https://toolidx.dev/server/${encodeURIComponent(s.id)}`,
				name: s.name,
			})),
		})
		: "";

	const categorySection = categories.length > 0
		? `<section class="categories">
    <h2>Browse by category</h2>
    <ul class="category-grid">
      ${categories.map(c => `<li>
        <a href="/category/${encodeURIComponent(c.slug)}">
          <span class="category-name">${escHtml(c.displayName)}</span>
          <span class="category-count">${c.count.toLocaleString("en-US")}</span>
        </a>
      </li>`).join("\n      ")}
    </ul>
  </section>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>toolidx — Verified MCP Server Directory</title>
  <meta name="description" content="Independent MCP server directory with machine-readable QC results — install commands, tool schemas, verification status, and multi-model evaluation scores. Evaluated, structured, queryable.">
  <link rel="canonical" href="https://toolidx.dev/">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="toolidx">
  <meta property="og:title" content="toolidx — Verified MCP Server Directory">
  <meta property="og:description" content="Machine-readable verification and status for MCP servers and AI tools. Evaluated, structured, queryable.">
  <meta property="og:url" content="https://toolidx.dev/">
  <meta property="og:image" content="https://toolidx.dev/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="toolidx — Verified MCP Server Directory">
  <meta name="twitter:description" content="Machine-readable verification and status for MCP servers and AI tools.">
  <meta name="twitter:image" content="https://toolidx.dev/og.png">
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","@id":"https://toolidx.dev/#website","url":"https://toolidx.dev/","name":"toolidx","description":"Independent MCP server directory and verification service","publisher":{"@id":"https://toolidx.dev/#org"}},{"@type":"Organization","@id":"https://toolidx.dev/#org","name":"toolidx","url":"https://toolidx.dev/","logo":"https://toolidx.dev/favicon.svg","sameAs":["https://github.com/directorybase/toolidx","https://directorybase.org"]}]}</script>
  ${itemListLd ? `<script type="application/ld+json">${itemListLd}</script>` : ""}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0f0f0f;
      --surface:   #1a1a1a;
      --border:    #2a2a2a;
      --text:      #f0f0f0;
      --muted:     #737373;
      --green:     #16a34a;
      --green-lt:  #4ade80;
      --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }

    html, body { height: 100%; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 16px;
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── Nav ── */
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 40px;
      border-bottom: 1px solid var(--border);
    }

    .nav-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text);
      font-family: var(--mono);
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }

    .nav-logo svg { flex-shrink: 0; }

    .nav-links {
      display: flex;
      gap: 28px;
      list-style: none;
    }

    .nav-links a {
      color: var(--muted);
      text-decoration: none;
      font-size: 13px;
      letter-spacing: 0.02em;
      transition: color 0.15s;
    }

    .nav-links a:hover { color: var(--text); }

    /* ── Hero ── */
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 80px 40px 60px;
      text-align: center;
    }

    .wordmark {
      font-family: var(--mono);
      font-size: clamp(36px, 6vw, 64px);
      font-weight: 700;
      letter-spacing: -0.04em;
      color: var(--text);
      margin-bottom: 20px;
    }

    .wordmark .g { color: var(--green-lt); }
    .wordmark { color: #ffffff; }

    .tagline {
      font-size: clamp(18px, 3vw, 26px);
      font-weight: 600;
      color: var(--text);
      margin-bottom: 12px;
      letter-spacing: -0.02em;
    }

    .subtitle {
      font-size: 15px;
      color: var(--muted);
      max-width: 480px;
      margin-bottom: 48px;
    }

    /* ── Stats ── */
    .stats {
      display: flex;
      gap: 2px;
      margin-bottom: 48px;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }

    .stat {
      padding: 20px 36px;
      background: var(--surface);
      text-align: center;
    }

    .stat + .stat { border-left: 1px solid var(--border); }

    .stat-value {
      font-family: var(--mono);
      font-size: 28px;
      font-weight: 700;
      color: var(--green-lt);
      letter-spacing: -0.03em;
      line-height: 1.2;
    }

    .stat-label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-top: 4px;
    }

    /* ── CTAs ── */
    .ctas {
      display: flex;
      gap: 12px;
      margin-bottom: 72px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 11px 22px;
      border-radius: 7px;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      transition: all 0.15s;
      cursor: pointer;
    }

    .btn-primary {
      background: var(--green);
      color: #fff;
      border: 1px solid var(--green);
    }

    .btn-primary:hover { background: #15803d; border-color: #15803d; }

    .btn-secondary {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover { border-color: #555; background: var(--surface); }

    /* ── Value row ── */
    .values {
      display: flex;
      gap: 1px;
      max-width: 680px;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      background: var(--border);
    }

    .value {
      flex: 1;
      padding: 24px 20px;
      background: var(--surface);
      text-align: left;
    }

    .value-icon {
      font-size: 20px;
      margin-bottom: 10px;
      color: var(--green-lt);
    }

    .value-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 6px;
    }

    .value-desc {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.5;
    }

    /* ── Recently verified ── */
    .recent {
      width: 100%;
      max-width: 880px;
      margin: 72px auto 0;
      text-align: left;
    }

    .recent h2 {
      font-size: 14px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    .recent-list {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }

    .recent-list li { background: var(--surface); }

    .recent-list a {
      display: block;
      padding: 14px 18px;
      text-decoration: none;
      color: var(--text);
      transition: background 0.15s;
    }

    .recent-list a:hover { background: #222; }

    .recent-name {
      display: block;
      font-family: var(--mono);
      font-size: 13px;
      color: var(--green-lt);
      letter-spacing: -0.01em;
      margin-bottom: 4px;
      word-break: break-word;
    }

    .recent-desc {
      display: block;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.45;
    }

    /* ── Browse by category ── */
    .categories {
      width: 100%;
      max-width: 880px;
      margin: 56px auto 0;
      text-align: left;
    }
    .categories h2 {
      font-size: 14px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .category-grid {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    .category-grid li { background: var(--surface); }
    .category-grid a {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      text-decoration: none;
      color: var(--text);
      font-family: var(--mono);
      font-size: 13px;
      transition: background 0.15s;
    }
    .category-grid a:hover { background: #222; }
    .category-name { color: var(--text); }
    .category-count {
      color: var(--green-lt);
      font-size: 11px;
      font-weight: 600;
    }

    /* ── Footer ── */
    footer {
      padding: 24px 40px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--muted);
    }

    .footer-links { display: flex; gap: 24px; list-style: none; }

    .footer-links a {
      color: var(--muted);
      text-decoration: none;
      font-family: var(--mono);
      font-size: 11px;
    }

    .footer-links a:hover { color: var(--text); }

    @media (max-width: 600px) {
      nav { padding: 16px 20px; }
      .nav-links { gap: 16px; }
      main { padding: 48px 20px 40px; }
      .stats { flex-direction: column; gap: 0; }
      .stat + .stat { border-left: none; border-top: 1px solid var(--border); }
      .values { flex-direction: column; }
      .recent { margin-top: 56px; }
      .recent-list { grid-template-columns: 1fr; }
      .categories { margin-top: 40px; }
      .category-grid { grid-template-columns: 1fr 1fr; }
      footer { flex-direction: column; gap: 16px; text-align: center; }
    }
  </style>
</head>
<body>

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
</nav>

<main>
  <div class="wordmark"><span class="g">tool</span>idx<span class="g">.dev</span></div>
  <div class="tagline">Verified tools. Structured trust.</div>
  <p class="subtitle">Machine-readable verification and status for MCP servers and AI tools.</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${count}</div>
      <div class="stat-label">Servers Indexed</div>
    </div>
    <div class="stat">
      <div class="stat-value" style="font-size:16px;padding-top:6px">${formatted}</div>
      <div class="stat-label">Last Updated</div>
    </div>
  </div>

  <div class="ctas">
    <a class="btn btn-primary" href="/docs">Browse API</a>
    <a class="btn btn-secondary" href="/v1/status">Status</a>
    <a class="btn btn-secondary" href="https://agenticwatch.dev">AgenticWatch ↗</a>
  </div>

  <div class="values">
    <div class="value">
      <div class="value-icon">✓</div>
      <div class="value-title">Install</div>
      <div class="value-desc">Find tools with clear verification status before you integrate.</div>
    </div>
    <div class="value">
      <div class="value-icon">▶</div>
      <div class="value-title">Start</div>
      <div class="value-desc">Standard metadata — install commands, tool schemas, package types.</div>
    </div>
    <div class="value">
      <div class="value-icon">◈</div>
      <div class="value-title">Trust</div>
      <div class="value-desc">Multi-model evaluation scores agents can read and act on.</div>
    </div>
  </div>

  ${categorySection}
  ${recentSection}
</main>

<footer>
  <span>toolidx.dev — independent MCP verification</span>
  <ul class="footer-links">
    <li><a href="/docs">API Docs</a></li>
    <li><a href="/openapi.json">OpenAPI</a></li>
    <li><a href="/llms.txt">llms.txt</a></li>
    <li><a href="/.well-known/mcp.json">mcp.json</a></li>
    <li><a href="https://agenticwatch.dev">AgenticWatch</a></li>
  </ul>
</footer>

</body>
</html>`;
}
