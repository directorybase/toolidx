import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";

export class ServerTools extends OpenAPIRoute {
	schema = {
		tags: ["Servers"],
		summary: "Get tool schemas for a server (lazy load — avoids fetching in list)",
		request: {
			params: z.object({
				id: z.string(),
			}),
		},
		responses: {
			"200": {
				description: "Tool schemas",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.object({
								server_id: z.string(),
								tool_count: z.number().nullable(),
								schema_weight_chars: z.number().nullable(),
								tools: z.array(z.any()),
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
			"SELECT id, tool_schemas, tool_count, schema_weight_chars FROM servers WHERE id = ?"
		).bind(id).first<Record<string, unknown>>();

		if (!row) {
			return c.json(
				{ success: false, errors: [{ code: 404, message: "Not found" }] },
				404,
			);
		}

		const tools = row.tool_schemas ? JSON.parse(row.tool_schemas as string) : [];

		return {
			success: true,
			result: {
				server_id: row.id,
				tool_count: row.tool_count ?? null,
				schema_weight_chars: row.schema_weight_chars ?? null,
				tools,
			},
		};
	}
}
