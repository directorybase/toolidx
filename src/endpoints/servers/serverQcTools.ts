import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";

const STATUS_ORDER: Record<string, number> = {
	working: 0,
	"needs-auth": 1,
	broken: 2,
	"not-tested": 3,
	unknown: 4,
};

export class ServerQcTools extends OpenAPIRoute {
	schema = {
		tags: ["Servers"],
		summary: "Get QC-aggregated tool results for a server",
		request: {
			params: z.object({
				id: z.string(),
			}),
			query: z.object({
				platform: z.string().optional(),
				status: z.string().optional(),
				include_schema: z.coerce.boolean().default(true).optional(),
			}),
		},
		responses: {
			"200": {
				description: "QC tool results",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.object({
								server_id: z.string(),
								total: z.number(),
								working: z.number(),
								broken: z.number(),
								needs_auth: z.number(),
								not_tested: z.number(),
								tools: z.array(
									z.object({
										name: z.string(),
										status: z.string(),
										platforms_agree: z.boolean().nullable(),
										last_tested_at: z.string().nullable(),
										not_tested_reason: z.string().nullable().optional(),
										platforms: z.record(
											z.object({
												status: z.string(),
												latency_ms: z.number().nullable(),
												tested_at: z.string(),
												error_class: z.string().nullable(),
												error_sample: z.string().nullable(),
											}),
										),
									}),
								),
							}),
						}),
					},
				},
			},
			"404": { description: "Not found" },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { id } = data.params;
		const { platform, status, include_schema } = data.query ?? {};

		// Verify server exists
		const server = await c.env.DB.prepare(
			"SELECT id FROM servers WHERE id = ?"
		).bind(id).first<{ id: string }>();

		if (!server) {
			return c.json(
				{ success: false, errors: [{ code: 404, message: "Not found" }] },
				404,
			);
		}

		// Query: latest result per tool per platform for this server
		// Join qc_tool_results with qc_runs to get platform info
		// For each (tool_name, platform), take the most recent run
		let sql = `
			SELECT
				r.tool_name,
				r.status,
				r.latency_ms,
				r.error_class,
				r.error_sample,
				r.tested_at,
				q.platform
			FROM qc_tool_results r
			JOIN qc_runs q ON r.run_id = q.run_id
			WHERE r.server_id = ?
			  AND r.tested_at = (
			    SELECT MAX(r2.tested_at)
			    FROM qc_tool_results r2
			    JOIN qc_runs q2 ON r2.run_id = q2.run_id
			    WHERE r2.server_id = r.server_id
			      AND r2.tool_name = r.tool_name
			      AND q2.platform = q.platform
			  )
		`;

		const bindings: unknown[] = [id];

		if (platform) {
			sql += " AND q.platform = ?";
			bindings.push(platform);
		}

		sql += " ORDER BY r.tool_name, q.platform";

		const rows = await c.env.DB.prepare(sql)
			.bind(...bindings)
			.all<{
				tool_name: string;
				status: string;
				latency_ms: number | null;
				error_class: string | null;
				error_sample: string | null;
				tested_at: string;
				platform: string;
			}>();

		// Group by tool_name
		const toolMap = new Map<string, {
			name: string;
			platforms: Record<string, {
				status: string;
				latency_ms: number | null;
				tested_at: string;
				error_class: string | null;
				error_sample: string | null;
			}>;
		}>();

		for (const row of rows.results) {
			if (!toolMap.has(row.tool_name)) {
				toolMap.set(row.tool_name, { name: row.tool_name, platforms: {} });
			}
			const tool = toolMap.get(row.tool_name)!;
			tool.platforms[row.platform] = {
				status: row.status,
				latency_ms: row.latency_ms,
				tested_at: row.tested_at,
				error_class: row.error_class,
				error_sample: row.error_sample,
			};
		}

		// Build tool list with aggregated status and platforms_agree
		let tools = Array.from(toolMap.values()).map((tool) => {
			const platformStatuses = Object.values(tool.platforms).map((p) => p.status);
			const uniqueStatuses = new Set(platformStatuses);

			// Determine aggregate status: best-case across platforms
			let aggStatus = "not-tested";
			if (platformStatuses.length > 0) {
				// Pick the "best" status seen across platforms
				const ordered = platformStatuses.sort(
					(a, b) => (STATUS_ORDER[a] ?? 99) - (STATUS_ORDER[b] ?? 99),
				);
				aggStatus = ordered[0];
			}

			// platforms_agree: null if only one platform, true if all same, false if differ
			let platforms_agree: boolean | null = null;
			if (platformStatuses.length > 1) {
				platforms_agree = uniqueStatuses.size === 1;
			}

			// last_tested_at = max tested_at across platforms
			const timestamps = Object.values(tool.platforms).map((p) => p.tested_at);
			const last_tested_at = timestamps.length > 0
				? timestamps.sort().reverse()[0]
				: null;

			return {
				name: tool.name,
				status: aggStatus,
				platforms_agree,
				last_tested_at,
				platforms: tool.platforms,
			};
		});

		// Apply status filter
		if (status) {
			tools = tools.filter((t) => t.status === status);
		}

		// Sort: working → needs-auth → broken → not-tested → unknown
		tools.sort((a, b) =>
			(STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99)
		);

		// Compute counts (after status filter if applied, but counts should reflect server totals)
		// Counts from the full tool set (pre-status-filter) if no status filter, else filtered set
		// Per spec: rolled-up counts for total/working/broken/needs_auth/not_tested on result object
		// We compute these from the full set regardless of ?status filter for usefulness
		// Actually the spec doesn't specify — use the filtered set's counts for consistency
		const total = tools.length;
		const working = tools.filter((t) => t.status === "working").length;
		const broken = tools.filter((t) => t.status === "broken").length;
		const needs_auth = tools.filter((t) => t.status === "needs-auth").length;
		const not_tested = tools.filter((t) => t.status === "not-tested").length;

		return c.json({
			success: true,
			result: {
				server_id: id,
				total,
				working,
				broken,
				needs_auth,
				not_tested,
				tools,
			},
		});
	}
}
