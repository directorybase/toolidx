import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";
import { requireAuth } from "../../middleware/auth";

export class ToolTestArgs extends OpenAPIRoute {
	schema = {
		tags: ["Tools"],
		summary: "Upsert cached test args for a tool schema",
		security: [{ apiKey: [] }],
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({
							schema_hash: z.string(),
							args: z.record(z.any()),
							generated_by: z.string(),
						}),
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Test args saved",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							schema_hash: z.string(),
						}),
					},
				},
			},
			"401": { description: "Unauthorized" },
		},
	};

	async handle(c: AppContext) {
		const authError = requireAuth(c);
		if (authError) return authError;

		const data = await this.getValidatedData<typeof this.schema>();
		const { schema_hash, args, generated_by } = data.body;

		const now = new Date().toISOString();

		await c.env.DB.prepare(`
			INSERT INTO tool_test_args (schema_hash, args, generated_by, generated_at, validated)
			VALUES (?, ?, ?, ?, 0)
			ON CONFLICT(schema_hash) DO UPDATE SET
				args = excluded.args,
				generated_by = excluded.generated_by,
				generated_at = excluded.generated_at,
				validated = 0
		`).bind(
			schema_hash,
			JSON.stringify(args),
			generated_by,
			now,
		).run();

		return c.json({ success: true, schema_hash });
	}
}
