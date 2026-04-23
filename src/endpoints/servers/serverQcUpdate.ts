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
							server_version: z.string().optional(),
							protocol_version: z.string().optional(),
							capabilities: z.record(z.any()).optional(),
							server_instructions: z.string().optional(),
							resources_list: z.array(z.any()).optional(),
							prompts_list: z.array(z.any()).optional(),
							has_destructive_tools: z.boolean().optional(),
							all_tools_readonly: z.boolean().optional(),
							install_duration_ms: z.number().int().optional(),
							requires_env_vars: z.boolean().optional(),
							description_quality_score: z.number().min(0).max(10).optional(),
							external_deps_detected: z.array(z.string()).optional(),
							setup_complexity: z.enum(["low", "medium", "high"]).optional(),
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
		const {
			qc_status, qc_error, tool_schemas,
			server_version, protocol_version,
			capabilities, server_instructions, resources_list, prompts_list,
			has_destructive_tools, all_tools_readonly,
			install_duration_ms, requires_env_vars,
			description_quality_score, external_deps_detected, setup_complexity,
		} = data.body;

		const now = new Date().toISOString();
		const tool_count = tool_schemas?.length ?? null;

		const result = await c.env.DB.prepare(`
			UPDATE servers
			SET qc_status = ?, qc_error = ?, qc_tested_at = ?,
			    tool_schemas = ?, tool_count = ?,
			    server_version = ?, protocol_version = ?,
			    capabilities = ?, server_instructions = ?, resources_list = ?, prompts_list = ?,
			    has_destructive_tools = ?, all_tools_readonly = ?,
			    install_duration_ms = ?, requires_env_vars = ?,
			    description_quality_score = ?, external_deps_detected = ?, setup_complexity = ?,
			    updated_at = ?
			WHERE id = ?
		`).bind(
			qc_status,
			qc_error ?? null,
			now,
			tool_schemas ? JSON.stringify(tool_schemas) : null,
			tool_count,
			server_version ?? null,
			protocol_version ?? null,
			capabilities ? JSON.stringify(capabilities) : null,
			server_instructions ?? null,
			resources_list ? JSON.stringify(resources_list) : null,
			prompts_list ? JSON.stringify(prompts_list) : null,
			has_destructive_tools ? 1 : 0,
			all_tools_readonly ? 1 : 0,
			install_duration_ms ?? null,
			requires_env_vars ? 1 : 0,
			description_quality_score ?? null,
			external_deps_detected ? JSON.stringify(external_deps_detected) : null,
			setup_complexity ?? null,
			now,
			id,
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
