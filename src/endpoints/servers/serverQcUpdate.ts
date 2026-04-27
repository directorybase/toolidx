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
							qc_error: z.string().nullable().optional(),
							tool_schemas: z.array(z.any()).nullable().optional(),
							server_version: z.string().nullable().optional(),
							protocol_version: z.string().nullable().optional(),
							capabilities: z.record(z.any()).nullable().optional(),
							server_instructions: z.string().nullable().optional(),
							resources_list: z.array(z.any()).nullable().optional(),
							prompts_list: z.array(z.any()).nullable().optional(),
							has_destructive_tools: z.boolean().nullable().optional(),
							all_tools_readonly: z.boolean().nullable().optional(),
							install_duration_ms: z.number().int().nullable().optional(),
							requires_env_vars: z.boolean().nullable().optional(),
							description_quality_score: z.number().min(0).max(10).nullable().optional(),
							external_deps_detected: z.array(z.string()).nullable().optional(),
							setup_complexity: z.enum(["low", "medium", "high"]).nullable().optional(),
							hangs_on_start: z.boolean().nullable().optional(),
							tools_list_duration_ms: z.number().int().nullable().optional(),
							qc_platform: z.enum(["github", "gitlab", "cirrus", "local", "unknown"]).nullable().optional(),
							schema_weight_chars: z.number().int().nullable().optional(),
							failure_class: z.enum([
								"install_fail_uvx_resolve",
								"install_fail_npm_404",
								"install_fail_npm_timeout",
								"bad_entrypoint_shim",
								"missing_env_vars",
								"missing_external_dep",
								"hangs_on_start",
								"protocol_error",
								"tools_list_empty",
								"tools_list_error",
								"auth_required",
								"unknown",
							]).nullable().optional(),
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
			hangs_on_start, tools_list_duration_ms, qc_platform, schema_weight_chars,
			failure_class,
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
			    hangs_on_start = ?, tools_list_duration_ms = ?, qc_platform = ?,
			    schema_weight_chars = ?,
			    failure_class = ?,
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
			hangs_on_start ? 1 : 0,
			tools_list_duration_ms ?? null,
			qc_platform ?? null,
			schema_weight_chars ?? null,
			failure_class ?? null,
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
