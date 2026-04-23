import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";

export class ToolsSearch extends OpenAPIRoute {
	schema = {
		tags: ["Tools"],
		summary: "Search tools across all verified MCP servers",
		request: {
			query: z.object({
				q: z.string().min(1).describe("Search term matched against tool name and description"),
				limit: z.coerce.number().min(1).max(100).default(20).optional(),
				page: z.coerce.number().min(1).default(1).optional(),
			}),
		},
		responses: {
			"200": {
				description: "Matching tools with their server context",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.array(z.object({
								server_id: z.string(),
								server_name: z.string(),
								install_command: z.string().nullable(),
								schema_weight_chars: z.number().nullable(),
								tool: z.object({
									name: z.string(),
									description: z.string().optional(),
									inputSchema: z.any().optional(),
									annotations: z.any().optional(),
								}),
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
		const { q, limit = 20, page = 1 } = data.query;
		const offset = (page - 1) * limit;
		const pattern = `%${q}%`;

		const [rows, countRow] = await Promise.all([
			c.env.DB.prepare(`
				SELECT s.id AS server_id, s.name AS server_name,
				       s.install_command, s.schema_weight_chars,
				       t.value AS tool_json
				FROM servers s, json_each(s.tool_schemas) t
				WHERE s.status = 'active' AND s.qc_status = 'passed'
				  AND s.tool_schemas IS NOT NULL
				  AND (
				    json_extract(t.value, '$.name') LIKE ?
				    OR json_extract(t.value, '$.description') LIKE ?
				  )
				ORDER BY s.quality_score DESC NULLS LAST, s.schema_weight_chars ASC NULLS LAST
				LIMIT ? OFFSET ?
			`).bind(pattern, pattern, limit, offset).all(),
			c.env.DB.prepare(`
				SELECT COUNT(*) AS count
				FROM servers s, json_each(s.tool_schemas) t
				WHERE s.status = 'active' AND s.qc_status = 'passed'
				  AND s.tool_schemas IS NOT NULL
				  AND (
				    json_extract(t.value, '$.name') LIKE ?
				    OR json_extract(t.value, '$.description') LIKE ?
				  )
			`).bind(pattern, pattern).first<{ count: number }>(),
		]);

		const result = rows.results.map((r: Record<string, unknown>) => ({
			server_id: r.server_id,
			server_name: r.server_name,
			install_command: r.install_command ?? null,
			schema_weight_chars: r.schema_weight_chars ?? null,
			tool: JSON.parse(r.tool_json as string),
		}));

		return {
			success: true,
			result,
			total: countRow?.count ?? 0,
			page,
			limit,
		};
	}
}
