import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { StatusEndpoint } from "./endpoints/status";
import { ServerCreate } from "./endpoints/servers/serverCreate";
import { ServerList } from "./endpoints/servers/serverList";
import { ServerGet } from "./endpoints/servers/serverGet";
import { ServerQcUpdate } from "./endpoints/servers/serverQcUpdate";
import { ServerUpdate } from "./endpoints/servers/serverUpdate";
import { ServerTools } from "./endpoints/servers/serverTools";
import { ServerQcTools } from "./endpoints/servers/serverQcTools";
import { ToolsSearch } from "./endpoints/tools/toolsSearch";
import { ToolTestArgs } from "./endpoints/tools/toolTestArgs";
import { QcArchive } from "./endpoints/servers/qcArchive";
import { SanityIngest } from "./endpoints/internal/sanityIngest";
import { renderLanding } from "./pages/landing";
import { renderLlmsTxt } from "./pages/llmstxt";
import { renderServerDetail, renderServerNotFound } from "./pages/serverDetail";
import { renderCategoryDetail, renderCategoryNotFound } from "./pages/categoryDetail";
import { CATEGORIES, categoryBySlug, classify } from "./lib/category";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
	if (err instanceof ApiException) {
		return c.json(
			{ success: false, errors: err.buildResponse() },
			err.status as ContentfulStatusCode,
		);
	}
	console.error("Global error handler caught:", err);
	return c.json(
		{ success: false, errors: [{ code: 7000, message: "Internal Server Error" }] },
		500,
	);
});

// Inject last_updated into every JSON response.
// - API endpoints: top-level field for agent consumption
// - OpenAPI spec (/openapi.json): injected into info.description for SwaggerUI heading
app.use("*", async (c, next) => {
	await next();

	const contentType = c.res.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) return;

	const meta = await c.env.DB.prepare(
		"SELECT value FROM metadata WHERE key = 'last_updated'"
	).first<{ value: string }>();
	const lastUpdated = meta?.value ?? new Date().toISOString();

	const body = await c.res.clone().json<Record<string, unknown>>();
	const path = new URL(c.req.url).pathname;

	if (path === "/openapi.json") {
		const info = body.info as Record<string, unknown>;
		info.description = `${info.description}  \n**Last updated:** ${lastUpdated}`;
	} else {
		body.last_updated = lastUpdated;
	}

	c.res = new Response(JSON.stringify(body), {
		status: c.res.status,
		headers: new Headers(c.res.headers),
	});
});

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#111111"/>
  <rect x="12" y="14" width="30" height="6" rx="3" fill="#FFFFFF"/>
  <rect x="12" y="27" width="30" height="6" rx="3" fill="#FFFFFF"/>
  <rect x="12" y="40" width="22" height="6" rx="3" fill="#FFFFFF"/>
  <circle cx="48" cy="48" r="8" fill="#16A34A"/>
</svg>`;

app.get("/", async (c) => {
	const [countRow, metaRow, recentRows, allActive] = await Promise.all([
		c.env.DB.prepare("SELECT COUNT(*) as count FROM servers WHERE status = 'active'").first<{ count: number }>(),
		c.env.DB.prepare("SELECT value FROM metadata WHERE key = 'last_updated'").first<{ value: string }>(),
		c.env.DB.prepare(
			`SELECT id, name, description FROM servers
			 WHERE status = 'active' AND qc_status = 'passed'
			   AND description IS NOT NULL AND length(description) >= 20
			 ORDER BY qc_tested_at DESC LIMIT 12`
		).all<{ id: string; name: string; description: string }>(),
		// For "Browse by category" — count servers per category by classifying in JS.
		// Single SELECT with id+name+description; downstream cost is the substring scan.
		c.env.DB.prepare(
			`SELECT id, name, description FROM servers
			 WHERE status = 'active'
			   AND description IS NOT NULL AND length(description) >= 20`
		).all<{ id: string; name: string; description: string }>(),
	]);
	const categoryCounts: Record<string, number> = {};
	for (const c of CATEGORIES) categoryCounts[c.slug] = 0;
	for (const row of (allActive.results ?? [])) {
		const cat = classify(row.name, row.description);
		categoryCounts[cat.slug] = (categoryCounts[cat.slug] ?? 0) + 1;
	}
	const categorySummaries = CATEGORIES.map(c => ({ ...c, count: categoryCounts[c.slug] ?? 0 }));
	return new Response(
		renderLanding(countRow?.count ?? 0, metaRow?.value ?? "", recentRows.results ?? [], categorySummaries),
		{ headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
	);
});

app.get("/category/:slug", async (c) => {
	const slug = c.req.param("slug");
	const category = categoryBySlug(slug);
	if (!category) {
		return new Response(renderCategoryNotFound(slug), {
			status: 404,
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
		});
	}
	// Pull all active servers with descriptions, classify in JS, filter by slug.
	// Cached at the edge per the /category/* Cache Rule (2h Edge TTL).
	const all = await c.env.DB.prepare(
		`SELECT * FROM servers
		 WHERE status = 'active'
		   AND description IS NOT NULL AND length(description) >= 20
		 ORDER BY qc_tested_at DESC NULLS LAST, updated_at DESC`
	).all<Record<string, unknown>>();
	const matching = (all.results ?? []).filter(r => classify(String(r.name ?? ""), String(r.description ?? "")).slug === slug);
	return new Response(renderCategoryDetail(category, matching), {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=0, must-revalidate",
		},
	});
});

app.get("/server/:id", async (c) => {
	const id = c.req.param("id");
	const server = await c.env.DB.prepare(
		"SELECT * FROM servers WHERE id = ? AND status = 'active'"
	).bind(id).first<Record<string, unknown>>();
	if (!server) {
		return new Response(renderServerNotFound(id), {
			status: 404,
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
		});
	}
	return new Response(renderServerDetail(server), {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=0, must-revalidate",
		},
	});
});

app.get("/llms.txt", async (c) => {
	const [countRow, metaRow] = await Promise.all([
		c.env.DB.prepare("SELECT COUNT(*) as count FROM servers WHERE status = 'active'").first<{ count: number }>(),
		c.env.DB.prepare("SELECT value FROM metadata WHERE key = 'last_updated'").first<{ value: string }>(),
	]);
	return new Response(renderLlmsTxt(countRow?.count ?? 0, metaRow?.value ?? ""), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Robots-Tag": "noindex",
		},
	});
});

app.get("/.well-known/mcp.json", async (c) => {
	const [countRow, metaRow] = await Promise.all([
		c.env.DB.prepare("SELECT COUNT(*) as count FROM servers WHERE status = 'active'").first<{ count: number }>(),
		c.env.DB.prepare("SELECT value FROM metadata WHERE key = 'last_updated'").first<{ value: string }>(),
	]);
	const payload = {
		name: "toolidx",
		description: "Independent MCP server directory and verification service",
		url: "https://toolidx.dev",
		version: "0.1.0",
		api: {
			rest: "https://toolidx.dev/v1",
			openapi: "https://toolidx.dev/openapi.json",
			docs: "https://toolidx.dev/docs",
		},
		capabilities: ["directory", "verification", "search", "evaluation"],
		stats: {
			servers_indexed: countRow?.count ?? 0,
			last_updated: metaRow?.value ?? null,
		},
		contact: { website: "https://directorybase.org" },
	};
	return c.json(payload);
});

app.get("/favicon.svg", (c) =>
	new Response(FAVICON_SVG, {
		headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
	})
);

app.get("/favicon.ico", (c) =>
	new Response(FAVICON_SVG, {
		headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
	})
);

// Sitemap escaping helpers — URL-path encoding and XML escaping are distinct concerns;
// both apply when interpolating IDs into <loc>. See plan v3 §3.5.
function xmlEsc(s: string): string {
	return s.replace(/[&<>"']/g, ch => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]!
	));
}
function safeServerLoc(id: string): string {
	return `https://toolidx.dev/server/${xmlEsc(encodeURIComponent(id))}`;
}

app.get("/sitemap.xml", async (c) => {
	const meta = await c.env.DB.prepare(
		"SELECT value FROM metadata WHERE key = 'last_updated'"
	).first<{ value: string }>();
	const lastmod = (meta?.value ?? new Date().toISOString()).slice(0, 10);

	// Indexable servers per §3.4 tier rules: any active server with a real description.
	// The renderer applies noindex meta for thin pages anyway, but excluding them
	// here keeps the sitemap from advertising URLs that say "don't index me."
	const servers = await c.env.DB.prepare(
		`SELECT id, updated_at FROM servers
		 WHERE status = 'active'
		   AND description IS NOT NULL
		   AND length(description) >= 20
		 ORDER BY updated_at DESC`
	).all<{ id: string; updated_at: string }>();

	// /docs (SwaggerUI, JS-rendered) and /llms.txt (text/plain, LLM target) are
	// intentionally NOT in the sitemap. GSC reported both as "Discovered —
	// currently not indexed" because they're not realistic search targets.
	// /llms.txt also gets an explicit X-Robots-Tag: noindex header (see route).
	const staticUrls = [
		{ loc: "https://toolidx.dev/", priority: "1.0", changefreq: "daily", lastmod },
	];
	// Category pages (16) — each is a real indexable URL with ItemList JSON-LD.
	const categoryUrls = CATEGORIES.map(cat => ({
		loc: `https://toolidx.dev/category/${xmlEsc(encodeURIComponent(cat.slug))}`,
		priority: "0.8",
		changefreq: "daily",
		lastmod,
	}));
	const serverUrls = (servers.results ?? []).map(s => ({
		loc: safeServerLoc(s.id),
		priority: "0.6",
		changefreq: "weekly",
		lastmod: xmlEsc((s.updated_at ?? lastmod).slice(0, 10)),
	}));
	const all = [...staticUrls, ...categoryUrls, ...serverUrls];

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${all.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join("\n")}
</urlset>`;

	return new Response(body, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
});

app.get("/robots.txt", (c) =>
	new Response(
		"User-agent: *\nAllow: /\nDisallow: /v1/\n\nSitemap: https://toolidx.dev/sitemap.xml\n",
		{
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		}
	)
);

const openapi = fromHono(app, {
	docs_url: "/docs",
	schema: {
		info: {
			title: "toolidx",
			version: "0.1.0",
			description: "Agent-first MCP server directory. Evaluated, structured, queryable. https://toolidx.dev",
		},
	},
});

openapi.get("/v1/status", StatusEndpoint);
openapi.get("/v1/servers", ServerList);
openapi.post("/v1/servers", ServerCreate);
openapi.get("/v1/servers/:id", ServerGet);
openapi.patch("/v1/servers/:id", ServerUpdate);
openapi.patch("/v1/servers/:id/qc", ServerQcUpdate);
openapi.get("/v1/servers/:id/tools", ServerTools);
openapi.get("/v1/servers/:id/qc_tools", ServerQcTools);
openapi.get("/v1/tools", ToolsSearch);
openapi.patch("/v1/tools/test_args", ToolTestArgs);
openapi.post("/internal/qc-archive", QcArchive);
openapi.post("/internal/sanity-ingest", SanityIngest);

export default app;
