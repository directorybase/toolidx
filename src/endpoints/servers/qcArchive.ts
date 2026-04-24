/**
 * POST /internal/qc-archive
 *
 * Accepts a completed QC run payload and commits it as an immutable JSON file
 * to the Gitea agenticwatch-results repo via the Gitea Contents API.
 *
 * Archive path: qc-runs/YYYY-MM-DD/{server_id}_{run_id}.json
 * Commit message: qc: {server_id} on {platform} at {started_at}
 *
 * Idempotent: if the file already exists (same run_id), returns 200 without
 * overwriting — run_ids are ULIDs and globally unique, so a collision means
 * the run was already archived.
 *
 * Auth: same X-API-Key as the rest of the toolidx API.
 * The Gitea token is stored as a Worker secret: GITEA_TOKEN.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";
import { requireAuth } from "../../middleware/auth";

const GITEA_BASE = "http://192.168.7.70:30008";
const GITEA_REPO_OWNER = "gitea_admin";
const GITEA_REPO_NAME = "agenticwatch-results";

const ToolResultSchema = z.object({
	tool_name: z.string(),
	status: z.enum(["working", "broken", "needs-auth", "not-tested", "unknown"]),
	latency_ms: z.number().int().nullable().optional(),
	error_class: z.string().nullable().optional(),
	error_sample: z.string().max(500).nullable().optional(),
	sample_args: z.any().optional(),
	tested_at: z.string(),
});

const ArchivePayloadSchema = z.object({
	run_id: z.string(),
	server_id: z.string(),
	platform: z.string(),
	runner_os: z.string().optional(),
	runner_arch: z.string().optional(),
	runner_runtime_version: z.string().optional(),
	status: z.enum(["passed", "failed", "error"]),
	install_duration_ms: z.number().int().nullable().optional(),
	tools_list_duration_ms: z.number().int().nullable().optional(),
	tools_tested_count: z.number().int().nullable().optional(),
	started_at: z.string(),
	finished_at: z.string().optional(),
	error_class: z.string().nullable().optional(),
	tool_results: z.array(ToolResultSchema).optional().default([]),
	tool_schemas: z.array(z.any()).optional().default([]),
});

export class QcArchive extends OpenAPIRoute {
	schema = {
		tags: ["Internal"],
		summary: "Archive a QC run to Gitea (immutable, forever retention)",
		security: [{ apiKey: [] }],
		request: {
			body: {
				content: {
					"application/json": {
						schema: ArchivePayloadSchema,
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Archived (or already exists)",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.object({
								path: z.string(),
								already_existed: z.boolean(),
								gitea_sha: z.string().optional(),
							}),
						}),
					},
				},
			},
			"401": { description: "Unauthorized" },
			"502": { description: "Gitea API error" },
		},
	};

	async handle(c: AppContext) {
		const authError = requireAuth(c);
		if (authError) return authError;

		const data = await this.getValidatedData<typeof this.schema>();
		const payload = data.body;

		const giteaToken = (c.env as any).GITEA_TOKEN as string | undefined;
		if (!giteaToken) {
			return c.json(
				{ success: false, errors: [{ code: 500, message: "GITEA_TOKEN secret not configured" }] },
				500,
			);
		}

		const datePrefix = payload.started_at.slice(0, 10);
		const filePath = `qc-runs/${datePrefix}/${payload.server_id}_${payload.run_id}.json`;

		const checkUrl = `${GITEA_BASE}/api/v1/repos/${GITEA_REPO_OWNER}/${GITEA_REPO_NAME}/contents/${filePath}`;
		const checkResp = await fetch(checkUrl, {
			headers: { Authorization: `token ${giteaToken}` },
		});

		if (checkResp.ok) {
			return c.json({
				success: true,
				result: { path: filePath, already_existed: true },
			});
		}

		if (checkResp.status !== 404) {
			const errText = await checkResp.text();
			return c.json(
				{ success: false, errors: [{ code: 502, message: `Gitea check failed: ${checkResp.status} ${errText}` }] },
				502,
			);
		}

		const archiveDoc = {
			archived_at: new Date().toISOString(),
			run: {
				run_id: payload.run_id,
				server_id: payload.server_id,
				platform: payload.platform,
				runner_os: payload.runner_os ?? null,
				runner_arch: payload.runner_arch ?? null,
				runner_runtime_version: payload.runner_runtime_version ?? null,
				status: payload.status,
				install_duration_ms: payload.install_duration_ms ?? null,
				tools_list_duration_ms: payload.tools_list_duration_ms ?? null,
				tools_tested_count: payload.tools_tested_count ?? null,
				started_at: payload.started_at,
				finished_at: payload.finished_at ?? null,
				error_class: payload.error_class ?? null,
			},
			tool_results: payload.tool_results,
			tool_schemas: payload.tool_schemas,
		};

		const content = btoa(unescape(encodeURIComponent(JSON.stringify(archiveDoc, null, 2))));
		const commitMessage = `qc: ${payload.server_id} on ${payload.platform} at ${payload.started_at}`;

		const createResp = await fetch(checkUrl, {
			method: "POST",
			headers: {
				Authorization: `token ${giteaToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ message: commitMessage, content }),
		});

		if (!createResp.ok) {
			const errText = await createResp.text();
			return c.json(
				{ success: false, errors: [{ code: 502, message: `Gitea create failed: ${createResp.status} ${errText}` }] },
				502,
			);
		}

		const createData = await createResp.json<{ content?: { sha?: string } }>();
		const sha = createData?.content?.sha;

		return c.json({
			success: true,
			result: {
				path: filePath,
				already_existed: false,
				...(sha ? { gitea_sha: sha } : {}),
			},
		});
	}
}
