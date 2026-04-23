import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";

export class ServerList extends OpenAPIRoute {
	schema = {
		tags: ["Servers"],
		summary: "List servers — compact summary, no tool schemas",
		request: {
			query: z.object({
				status: z.enum(["active", "pending", "rejected"]).default("active").optional(),
				qc_status: z.enum(["pending", "passed", "failed", "error", "skipped"]).optional(),
				is_proxy: z.coerce.boolean().optional(),
				hangs_on_start: z.coerce.boolean().optional(),
				requires_env_vars: z.coerce.boolean().optional(),
				qc_platform: z.enum(["github", "gitlab", "local"]).optional(),
				limit: z.coerce.number().min(1).max(100).default(50).optional(),
				page: z.coerce.number().min(1).default(1).optional(),
			}),
		},
		responses: {
			"200": {
				description: "List of servers (compact — use GET /v1/servers/:id for full record, /v1/servers/:id/tools for schemas)",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.array(z.object({
								id: z.string(),
								name: z.string(),
								description: z.string(),
								repository_url: z.string().nullable(),
								package_type: z.string().nullable(),
								package_name: z.string().nullable(),
								npm_version: z.string().nullable(),
								install_command: z.string().nullable(),
								qc_status: z.string(),
								tool_count: z.number().nullable(),
								schema_weight_chars: z.number().nullable(),
								install_duration_ms: z.number().nullable(),
								tools_list_duration_ms: z.number().nullable(),
								requires_env_vars: z.boolean().nullable(),
								hangs_on_start: z.boolean().nullable(),
								is_proxy: z.boolean().nullable(),
								setup_complexity: z.string().nullable(),
								qc_platform: z.string().nullable(),
								quality_score: z.number().nullable(),
								status: z.string(),
								updated_at: z.string(),
							})),
							total: z.number(),
							page: z.number(),
							limit: z.number(),
						}),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const {
			status = "active", qc_status, is_proxy, hangs_on_start,
			requires_env_vars, qc_platform, limit = 50, page = 1,
		} = data.query;

		const offset = (page - 1) * limit;
		const conditions: string[] = ["1=1"];
		const params: (string | number)[] = [];

		if (status) { conditions.push("status = ?"); params.push(status); }
		if (qc_status) { conditions.push("qc_status = ?"); params.push(qc_status); }
		if (is_proxy !== undefined) { conditions.push("is_proxy = ?"); params.push(is_proxy ? 1 : 0); }
		if (hangs_on_start !== undefined) { conditions.push("hangs_on_start = ?"); params.push(hangs_on_start ? 1 : 0); }
		if (requires_env_vars !== undefined) { conditions.push("requires_env_vars = ?"); params.push(requires_env_vars ? 1 : 0); }
		if (qc_platform) { conditions.push("qc_platform = ?"); params.push(qc_platform); }

		const where = conditions.join(" AND ");

		const [rows, countRow] = await Promise.all([
			c.env.DB.prepare(
				`SELECT id, name, description, repository_url, package_type, package_name, npm_version,
				        install_command, qc_status, tool_count, schema_weight_chars,
				        install_duration_ms, tools_list_duration_ms,
				        requires_env_vars, hangs_on_start, is_proxy,
				        setup_complexity, qc_platform,
				        quality_score, status, updated_at
				 FROM servers WHERE ${where}
				 ORDER BY quality_score DESC NULLS LAST, updated_at DESC
				 LIMIT ? OFFSET ?`
			).bind(...params, limit, offset).all(),
			c.env.DB.prepare(
				`SELECT COUNT(*) as count FROM servers WHERE ${where}`
			).bind(...params).first<{ count: number }>(),
		]);

		return {
			success: true,
			result: rows.results.map((r: Record<string, unknown>) => ({
				...r,
				requires_env_vars: r.requires_env_vars === 1,
				hangs_on_start: r.hangs_on_start === 1,
				is_proxy: r.is_proxy === 1,
			})),
			total: countRow?.count ?? 0,
			page,
			limit,
		};
	}
}
