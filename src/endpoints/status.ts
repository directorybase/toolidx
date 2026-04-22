import { OpenAPIRoute } from "chanfana";
import { z } from "zod";

export class StatusEndpoint extends OpenAPIRoute {
	schema = {
		tags: ["System"],
		summary: "Service status and pipeline health",
		responses: {
			"200": {
				description: "Service status",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							last_updated: z.string().datetime().describe("ISO 8601 UTC timestamp of last index update"),
							result: z.object({
								service: z.string(),
								version: z.string(),
								ready: z.boolean(),
								description: z.string(),
							}),
						}),
					},
				},
			},
		},
	};

	async handle() {
		return {
			success: true,
			result: {
				service: "toolidx",
				version: "0.1.0",
				ready: false,
				description: "Agent-first MCP server directory. Evaluated, structured, queryable.",
			},
		};
	}
}
