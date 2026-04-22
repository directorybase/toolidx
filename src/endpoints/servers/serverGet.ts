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

		const row = await c.env.DB.prepare(
			"SELECT * FROM servers WHERE id = ?"
		).bind(id).first<Record<string, unknown>>();

		if (!row) {
			return c.json(
				{ success: false, errors: [{ code: 404, message: "Not found" }] },
				404,
			);
		}

		return {
			success: true,
			result: {
				...row,
				tags: row.tags ? JSON.parse(row.tags as string) : null,
				tool_schemas: row.tool_schemas ? JSON.parse(row.tool_schemas as string) : null,
			},
		};
	}
}
