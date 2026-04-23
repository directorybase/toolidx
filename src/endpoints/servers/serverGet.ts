import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";

export class ServerGet extends OpenAPIRoute {
	schema = {
		tags: ["Servers"],
		summary: "Get a single server listing",
		request: {
			params: z.object({
				id: z.string(),
			}),
			query: z.object({
				slim: z.coerce.boolean().default(false).optional(),
			}),
		},
		responses: {
			"200": {
				description: "Server record",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.object({
								id: z.string(),
								name: z.string(),
								description: z.string(),
								repository_url: z.string().nullable(),
								package_name: z.string().nullable(),
								package_type: z.string().nullable(),
								install_command: z.string().nullable(),
								homepage_url: z.string().nullable(),
								tags: z.array(z.string()).nullable(),
								tool_schemas: z.any().nullable(),
								tool_count: z.number().nullable(),
								qc_status: z.string(),
								qc_error: z.string().nullable(),
								qc_tested_at: z.string().nullable(),
								server_version: z.string().nullable(),
								protocol_version: z.string().nullable(),
								capabilities: z.any().nullable(),
								server_instructions: z.string().nullable(),
								resources_list: z.any().nullable(),
								prompts_list: z.any().nullable(),
								has_destructive_tools: z.boolean().nullable(),
								all_tools_readonly: z.boolean().nullable(),
								install_duration_ms: z.number().nullable(),
								tools_list_duration_ms: z.number().nullable(),
								requires_env_vars: z.boolean().nullable(),
								hangs_on_start: z.boolean().nullable(),
								is_proxy: z.boolean().nullable(),
								schema_weight_chars: z.number().nullable(),
								qc_platform: z.string().nullable(),
								sanity_score: z.number().nullable(),
								quality_score: z.number().nullable(),
								status: z.string(),
								source: z.string().nullable(),
								created_at: z.string(),
								updated_at: z.string(),
							}).nullable(),
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
		const slim = data.query?.slim ?? false;

		const row = await c.env.DB.prepare(
			"SELECT * FROM servers WHERE id = ?"
		).bind(id).first<Record<string, unknown>>();

		if (!row) {
			return c.json(
				{ success: false, errors: [{ code: 404, message: "Not found" }] },
				404,
			);
		}

		const result: Record<string, unknown> = {
			...row,
			tags: row.tags ? JSON.parse(row.tags as string) : null,
			tool_schemas: slim ? undefined : (row.tool_schemas ? JSON.parse(row.tool_schemas as string) : null),
			capabilities: row.capabilities ? JSON.parse(row.capabilities as string) : null,
			resources_list: slim ? undefined : (row.resources_list ? JSON.parse(row.resources_list as string) : null),
			prompts_list: slim ? undefined : (row.prompts_list ? JSON.parse(row.prompts_list as string) : null),
			has_destructive_tools: row.has_destructive_tools === 1,
			all_tools_readonly: row.all_tools_readonly === 1,
			requires_env_vars: row.requires_env_vars === 1,
			hangs_on_start: row.hangs_on_start === 1,
			is_proxy: row.is_proxy === 1,
		};

		return { success: true, result };
	}
}
