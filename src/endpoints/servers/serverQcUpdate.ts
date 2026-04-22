import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";
import { requireAuth } from "../../middleware/auth";

export class ServerQcUpdate extends OpenAPIRoute {
	schema = {
		tags: ["Servers"],
		summary: "Update QC test result for a server",
		security: [{ apiKey: [] }],
		request: {
			params: z.object({
				id: z.string(),
			}),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							qc_status: z.enum(["passed", "failed", "error", "skipped"]),
							qc_error: z.string().optional(),
							tool_schemas: z.array(z.any()).optional(),
						}),
					},
				},
			},
		},
		responses: {
			"200": {
				description: "QC result updated",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.object({ id: z.string() }),
						}),
					},
				},
			},
			"401": { description: "Unauthorized" },
			"404": { description: "Not found" },
		},
	};

	async handle(c: AppContext) {
		const authError = requireAuth(c);
		if (authError) return authError;

		const data = await this.getValidatedData<typeof this.schema>();
		const { id } = data.params;
		const { qc_status, qc_error, tool_schemas } = data.body;

		const now = new Date().toISOString();
		const tool_count = tool_schemas?.length ?? null;

		const result = await c.env.DB.prepare(`
			UPDATE servers
			SET qc_status = ?, qc_error = ?, qc_tested_at = ?,
			    tool_schemas = ?, tool_count = ?, updated_at = ?
			WHERE id = ?
		`).bind(
			qc_status, qc_error ?? null, now,
			tool_schemas ? JSON.stringify(tool_schemas) : null,
			tool_count, now, id,
		).run();

		if (result.meta.changes === 0) {
			return c.json(
				{ success: false, errors: [{ code: 404, message: "Not found" }] },
				404,
			);
		}

		return { success: true, result: { id } };
	}
}
