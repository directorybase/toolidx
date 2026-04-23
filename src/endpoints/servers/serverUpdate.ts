import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";
import { requireAuth } from "../../middleware/auth";

export class ServerUpdate extends OpenAPIRoute {
	schema = {
		tags: ["Servers"],
		summary: "Partial metadata update for a server (discovery agent use)",
		security: [{ apiKey: [] }],
		request: {
			params: z.object({ id: z.string() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							install_command: z.string().optional(),
							package_type: z.enum(["npm", "uvx", "pip"]).optional(),
							package_name: z.string().optional(),
							min_node_version: z.string().optional(),
							homepage_url: z.string().optional(),
							tags: z.array(z.string()).optional(),
							status: z.enum(["active", "pending", "rejected"]).optional(),
						}),
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Server updated",
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
		const body = data.body;

		const sets: string[] = [];
		const params: (string | null)[] = [];

		if (body.install_command !== undefined) { sets.push("install_command = ?"); params.push(body.install_command); }
		if (body.package_type !== undefined) { sets.push("package_type = ?"); params.push(body.package_type); }
		if (body.package_name !== undefined) { sets.push("package_name = ?"); params.push(body.package_name); }
		if (body.min_node_version !== undefined) { sets.push("min_node_version = ?"); params.push(body.min_node_version); }
		if (body.homepage_url !== undefined) { sets.push("homepage_url = ?"); params.push(body.homepage_url); }
		if (body.tags !== undefined) { sets.push("tags = ?"); params.push(JSON.stringify(body.tags)); }
		if (body.status !== undefined) { sets.push("status = ?"); params.push(body.status); }

		if (sets.length === 0) {
			return c.json({ success: false, errors: [{ code: 400, message: "No fields to update" }] }, 400);
		}

		const now = new Date().toISOString();
		sets.push("updated_at = ?");
		params.push(now);
		params.push(id);

		const result = await c.env.DB.prepare(
			`UPDATE servers SET ${sets.join(", ")} WHERE id = ?`
		).bind(...params).run();

		if (result.meta.changes === 0) {
			return c.json({ success: false, errors: [{ code: 404, message: "Not found" }] }, 404);
		}

		return { success: true, result: { id } };
	}
}
