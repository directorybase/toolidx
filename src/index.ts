import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { StatusEndpoint } from "./endpoints/status";
import { ServerCreate } from "./endpoints/servers/serverCreate";
import { ServerList } from "./endpoints/servers/serverList";
import { ServerGet } from "./endpoints/servers/serverGet";
import { ServerQcUpdate } from "./endpoints/servers/serverQcUpdate";

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

const openapi = fromHono(app, {
	docs_url: "/",
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
openapi.patch("/v1/servers/:id/qc", ServerQcUpdate);

export default app;
