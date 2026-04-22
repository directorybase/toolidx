import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";

export class ServerList extends OpenAPIRoute {
	schema = {
		tags: ["Servers"],
		summary: "List server listings",
		request: {
			query: z.object({
				status: z.enum(["active", "pending", "rejected"]).default("active").optional(),
				qc_status: z.enum(["pending", "passed", "failed", "error", "skipped"]).optional(),
				limit: z.coerce.number().min(1).max(100).default(50).optional(),
				offset: z.coerce.number().min(0).default(0).optional(),
			}),
		},
		responses: {
			"200": {
				description: "List of servers",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.array(z.object({
								id: z.string(),
								name: z.string(),
								description: z.string(),
								package_type: z.string().nullable(),
								install_command: z.string().nullable(),
								qc_status: z.string(),
								quality_score: z.number().nullable(),
								status: z.string(),
								updated_at: z.string(),
							})),
							total: z.number(),
						}),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { status = "active", qc_status, limit = 50, offset = 0 } = data.query;

		const conditions: string[] = ["1=1"];
		const params: (string | number)[] = [];

		if (status) { conditions.push("status = ?"); params.push(status); }
		if (qc_status) { conditions.push("qc_status = ?"); params.push(qc_status); }

		const where = conditions.join(" AND ");

		const [rows, countRow] = await Promise.all([
			c.env.DB.prepare(
				`SELECT id, name, description, package_type, install_command,
				        qc_status, quality_score, status, updated_at
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
			result: rows.results,
			total: countRow?.count ?? 0,
		};
	}
}
