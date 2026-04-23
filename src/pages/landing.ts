export function renderLanding(serverCount: number, lastUpdated: string): string {
	const formatted = lastUpdated
		? new Date(lastUpdated).toLocaleString("en-US", {
				month: "short", day: "numeric", year: "numeric",
				hour: "2-digit", minute: "2-digit",
				timeZone: "UTC", timeZoneName: "short",
		  })
		: "—";

	const count = serverCount.toLocaleString("en-US");

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>toolidx — Verified MCP Server Directory</title>
  <meta name="description" content="Machine-readable verification and status for MCP servers and AI tools. Evaluated, structured, queryable.">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
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

    .wordmark span { color: var(--green); }

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
  </ul>
</nav>

<main>
  <div class="wordmark">toolidx<span>.dev</span></div>
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
