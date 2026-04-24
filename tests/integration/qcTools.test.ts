import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = "test-api-key";

/** Insert a minimal server row so FK constraints on qc_runs are satisfied. */
async function seedServer(id: string) {
	await env.DB.prepare(`
		INSERT OR IGNORE INTO servers (id, name, description, qc_status, status, created_at, updated_at)
		VALUES (?, ?, ?, 'passed', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
	`).bind(id, id, "test server").run();
}

/** Insert a qc_run row; returns run_id. */
async function seedRun(runId: string, serverId: string, platform: string) {
	await env.DB.prepare(`
		INSERT OR IGNORE INTO qc_runs (run_id, server_id, platform, status, started_at)
		VALUES (?, ?, ?, 'passed', '2026-04-23T10:00:00Z')
	`).bind(runId, serverId, platform).run();
}

/** Insert a qc_tool_results row. */
async function seedToolResult(opts: {
	runId: string;
	serverId: string;
	toolName: string;
	status: string;
	latencyMs?: number | null;
	errorClass?: string | null;
	errorSample?: string | null;
	testedAt?: string;
}) {
	await env.DB.prepare(`
		INSERT OR IGNORE INTO qc_tool_results
			(run_id, server_id, tool_name, status, latency_ms, error_class, error_sample, tested_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		opts.runId,
		opts.serverId,
		opts.toolName,
		opts.status,
		opts.latencyMs ?? null,
		opts.errorClass ?? null,
		opts.errorSample ?? null,
		opts.testedAt ?? "2026-04-23T10:00:00Z",
	).run();
}

// ---------------------------------------------------------------------------
// GET /v1/servers/{id}/qc_tools
// ---------------------------------------------------------------------------

describe("GET /v1/servers/:id/qc_tools", () => {
	const SERVER = "test-server-qctools";

	beforeEach(async () => {
		// Clean up between tests
		await env.DB.prepare("DELETE FROM qc_tool_results WHERE server_id = ?").bind(SERVER).run();
		await env.DB.prepare("DELETE FROM qc_runs WHERE server_id = ?").bind(SERVER).run();
		await env.DB.prepare("DELETE FROM servers WHERE id = ?").bind(SERVER).run();
	});

	it("returns 404 for unknown server", async () => {
		const res = await SELF.fetch(`http://local.test/v1/servers/does-not-exist/qc_tools`);
		expect(res.status).toBe(404);
		const body = await res.json<any>();
		expect(body.success).toBe(false);
	});

	it("returns empty tools array when no results exist", async () => {
		await seedServer(SERVER);
		const res = await SELF.fetch(`http://local.test/v1/servers/${SERVER}/qc_tools`);
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.success).toBe(true);
		expect(body.result.server_id).toBe(SERVER);
		expect(body.result.tools).toEqual([]);
		expect(body.result.total).toBe(0);
		expect(body.result.working).toBe(0);
	});

	it("returns correct shape and counts from seeded qc_tool_results", async () => {
		await seedServer(SERVER);
		await seedRun("run-gh-1", SERVER, "github");
		await seedRun("run-gl-1", SERVER, "gitlab");

		// get_issue: working on both platforms
		await seedToolResult({ runId: "run-gh-1", serverId: SERVER, toolName: "get_issue", status: "working", latencyMs: 87, testedAt: "2026-04-23T10:00:00Z" });
		await seedToolResult({ runId: "run-gl-1", serverId: SERVER, toolName: "get_issue", status: "working", latencyMs: 94, testedAt: "2026-04-23T10:15:00Z" });

		// create_pr: needs-auth on both
		await seedToolResult({ runId: "run-gh-1", serverId: SERVER, toolName: "create_pr", status: "needs-auth", errorClass: "unauthorized", testedAt: "2026-04-23T10:00:00Z" });
		await seedToolResult({ runId: "run-gl-1", serverId: SERVER, toolName: "create_pr", status: "needs-auth", errorClass: "unauthorized", testedAt: "2026-04-23T10:15:00Z" });

		// delete_repo: not-tested (only on github)
		await seedToolResult({ runId: "run-gh-1", serverId: SERVER, toolName: "delete_repo", status: "not-tested", testedAt: "2026-04-23T10:00:00Z" });

		const res = await SELF.fetch(`http://local.test/v1/servers/${SERVER}/qc_tools`);
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		const r = body.result;

		expect(r.server_id).toBe(SERVER);
		expect(r.total).toBe(3);
		expect(r.working).toBe(1);
		expect(r.needs_auth).toBe(1);
		expect(r.not_tested).toBe(1);
		expect(r.broken).toBe(0);

		// Sort order: working → needs-auth → not-tested
		expect(r.tools[0].name).toBe("get_issue");
		expect(r.tools[0].status).toBe("working");
		expect(r.tools[1].name).toBe("create_pr");
		expect(r.tools[1].status).toBe("needs-auth");
		expect(r.tools[2].name).toBe("delete_repo");
		expect(r.tools[2].status).toBe("not-tested");

		// platforms object populated
		expect(r.tools[0].platforms).toHaveProperty("github");
		expect(r.tools[0].platforms).toHaveProperty("gitlab");
		expect(r.tools[0].platforms.github.latency_ms).toBe(87);

		// last_tested_at = max across platforms
		expect(r.tools[0].last_tested_at).toBe("2026-04-23T10:15:00Z");
	});

	it("platforms_agree is true when all platforms agree, false when they differ", async () => {
		await seedServer(SERVER);
		await seedRun("run-agree-gh", SERVER, "github");
		await seedRun("run-agree-gl", SERVER, "gitlab");

		// agree_tool: working on both → platforms_agree = true
		await seedToolResult({ runId: "run-agree-gh", serverId: SERVER, toolName: "agree_tool", status: "working" });
		await seedToolResult({ runId: "run-agree-gl", serverId: SERVER, toolName: "agree_tool", status: "working" });

		// disagree_tool: working on github, broken on gitlab → platforms_agree = false
		await seedToolResult({ runId: "run-agree-gh", serverId: SERVER, toolName: "disagree_tool", status: "working" });
		await seedToolResult({ runId: "run-agree-gl", serverId: SERVER, toolName: "disagree_tool", status: "broken" });

		// single_platform_tool: only on github → platforms_agree = null
		await seedToolResult({ runId: "run-agree-gh", serverId: SERVER, toolName: "single_platform_tool", status: "working" });

		const res = await SELF.fetch(`http://local.test/v1/servers/${SERVER}/qc_tools`);
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		const byName = Object.fromEntries(body.result.tools.map((t: any) => [t.name, t]));

		expect(byName["agree_tool"].platforms_agree).toBe(true);
		expect(byName["disagree_tool"].platforms_agree).toBe(false);
		expect(byName["single_platform_tool"].platforms_agree).toBeNull();
	});

	it("?platform filter returns only results for that platform", async () => {
		await seedServer(SERVER);
		await seedRun("run-pfilt-gh", SERVER, "github");
		await seedRun("run-pfilt-gl", SERVER, "gitlab");

		await seedToolResult({ runId: "run-pfilt-gh", serverId: SERVER, toolName: "tool_a", status: "working" });
		await seedToolResult({ runId: "run-pfilt-gl", serverId: SERVER, toolName: "tool_a", status: "broken" });

		const res = await SELF.fetch(`http://local.test/v1/servers/${SERVER}/qc_tools?platform=github`);
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		const tool = body.result.tools[0];
		expect(tool.name).toBe("tool_a");
		// Only github platform in the result
		expect(Object.keys(tool.platforms)).toEqual(["github"]);
		// Aggregate status from github only → working
		expect(tool.status).toBe("working");
	});

	it("?status filter returns only tools matching that status", async () => {
		await seedServer(SERVER);
		await seedRun("run-sfilt-gh", SERVER, "github");

		await seedToolResult({ runId: "run-sfilt-gh", serverId: SERVER, toolName: "tool_working", status: "working" });
		await seedToolResult({ runId: "run-sfilt-gh", serverId: SERVER, toolName: "tool_broken", status: "broken" });

		const res = await SELF.fetch(`http://local.test/v1/servers/${SERVER}/qc_tools?status=working`);
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.result.tools).toHaveLength(1);
		expect(body.result.tools[0].name).toBe("tool_working");
	});
});

// ---------------------------------------------------------------------------
// PATCH /v1/tools/test_args
// ---------------------------------------------------------------------------

describe("PATCH /v1/tools/test_args", () => {
	const HASH = "sha256-test-abc123";

	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM tool_test_args WHERE schema_hash = ?").bind(HASH).run();
	});

	it("rejects without X-API-Key (401)", async () => {
		const res = await SELF.fetch("http://local.test/v1/tools/test_args", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ schema_hash: HASH, args: { q: "test" }, generated_by: "naive" }),
		});
		expect(res.status).toBe(401);
		const body = await res.json<any>();
		expect(body.success).toBe(false);
	});

	it("rejects with wrong X-API-Key (401)", async () => {
		const res = await SELF.fetch("http://local.test/v1/tools/test_args", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "X-API-Key": "wrong-key" },
			body: JSON.stringify({ schema_hash: HASH, args: { q: "test" }, generated_by: "naive" }),
		});
		expect(res.status).toBe(401);
	});

	it("writes a row on first PATCH", async () => {
		const res = await SELF.fetch("http://local.test/v1/tools/test_args", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
			body: JSON.stringify({ schema_hash: HASH, args: { repo: "test", owner: "acme" }, generated_by: "qwen2.5-7b" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.success).toBe(true);
		expect(body.schema_hash).toBe(HASH);

		// Verify row in DB
		const row = await env.DB.prepare("SELECT * FROM tool_test_args WHERE schema_hash = ?")
			.bind(HASH).first<any>();
		expect(row).not.toBeNull();
		expect(JSON.parse(row.args)).toEqual({ repo: "test", owner: "acme" });
		expect(row.generated_by).toBe("qwen2.5-7b");
		expect(row.validated).toBe(0);
	});

	it("second PATCH overwrites the first row (upsert)", async () => {
		// First write
		await SELF.fetch("http://local.test/v1/tools/test_args", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
			body: JSON.stringify({ schema_hash: HASH, args: { q: "old" }, generated_by: "naive" }),
		});

		// Second write — different args
		const res = await SELF.fetch("http://local.test/v1/tools/test_args", {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
			body: JSON.stringify({ schema_hash: HASH, args: { q: "new", page: 1 }, generated_by: "qwen2.5-7b" }),
		});
		expect(res.status).toBe(200);

		// Only one row, with updated values
		const rows = await env.DB.prepare("SELECT * FROM tool_test_args WHERE schema_hash = ?")
			.bind(HASH).all<any>();
		expect(rows.results).toHaveLength(1);
		expect(JSON.parse(rows.results[0].args)).toEqual({ q: "new", page: 1 });
		expect(rows.results[0].generated_by).toBe("qwen2.5-7b");
		expect(rows.results[0].validated).toBe(0);
	});
});
