import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";
import { requireAuth } from "../../middleware/auth";
import { deriveServerId } from "../../lib/id";

export class ServerCreate extends OpenAPIRoute {
	schema = {
		tags: ["Servers"],
		summary: "Create or update a server listing",
		security: [{ apiKey: [] }],
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.object({
							id: z.string().optional().describe("Omit to derive from repository_url"),
							name: z.string(),
							description: z.string().default(""),
							repository_url: z.string().optional(),
							package_name: z.string().optional(),
							package_type: z.enum(["npm", "uvx", "pip"]).optional(),
							install_command: z.string().optional(),
							homepage_url: z.string().optional(),
							tags: z.array(z.string()).optional(),
							sanity_score: z.number().min(0).max(10).optional(),
							quality_score: z.number().min(0).max(10).optional(),
							status: z.enum(["active", "pending", "rejected"]).default("active"),
							source: z.string().optional(),
						}),
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Server created or updated",
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
			"400": { description: "Bad request" },
		},
	};

	async handle(c: AppContext) {
		const authError = requireAuth(c);
		if (authError) return authError;

		const data = await this.getValidatedData<typeof this.schema>();
		const body = data.body;

		const id = body.id ?? (body.repository_url ? deriveServerId(body.repository_url) : null);
		if (!id) {
			return c.json(
				{ success: false, errors: [{ code: 400, message: "Provide id or repository_url" }] },
				400,
			);
		}

		const now = new Date().toISOString();
		await c.env.DB.prepare(`
			INSERT INTO servers (id, name, description, repository_url, package_name, package_type,
				install_command, homepage_url, tags, sanity_score, quality_score, status, source,
				created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name = excluded.name,
				description = excluded.description,
				repository_url = excluded.repository_url,
				package_name = excluded.package_name,
				package_type = excluded.package_type,
				install_command = excluded.install_command,
				homepage_url = excluded.homepage_url,
				tags = excluded.tags,
				sanity_score = excluded.sanity_score,
				quality_score = excluded.quality_score,
				status = excluded.status,
				source = excluded.source,
				updated_at = excluded.updated_at
		`).bind(
			id, body.name, body.description,
			body.repository_url ?? null, body.package_name ?? null, body.package_type ?? null,
			body.install_command ?? null, body.homepage_url ?? null,
			body.tags ? JSON.stringify(body.tags) : null,
			body.sanity_score ?? null, body.quality_score ?? null,
			body.status, body.source ?? null, now, now,
		).run();

		return { success: true, result: { id } };
	}
}
