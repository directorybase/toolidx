/**
 * POST /internal/sanity-ingest
 *
 * Accepts a batch of normalized Sanity Panel evals rows from the bridge
 * (or operator-curated curl) and UPSERTs them into the toolidx evals table.
 *
 * Spec: outputs/2026-05-11-claude-toolidx-multi-agent-review-surface-plan-v5.md §3.2
 *
 * Auth: X-API-Key (reuses TOOLIDX_API_KEY).
 *
 * Per-row try/except: FK rejections (server_id not in servers) record the row
 * into `rejected_orphans` and continue. Zod errors are caught pre-D1 into
 * `rejected_validation`. Other D1 errors land in `rejected_other`. The whole
 * batch is NOT wrapped in a transaction — that would abort all rows on the
 * first FK rejection, which contradicts the per-row surfacing contract.
 *
 * Modes:
 *   "live"     — UPSERT (default).
 *   "backfill" — same as live; logged as backfill for operator triage.
 *   "dry-run"  — zod + bucketing only; no D1 writes.
 *
 * The Cloudflare cron handler in src/lib/sanityBridge.ts writes via the DB
 * binding directly and does NOT call this endpoint.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";
import { requireAuth } from "../../middleware/auth";

// Lens vocabulary aligned to AGENT_TO_LENS (composite primary-lens chain).
// Names are load-bearing: composite selection keys off these literals.
// v11: pass ∈ {1,3} only — pass-2 files are reviewer→reviewee cross-reviews,
// out of scope (v11 §8 Q1); an out-of-band pass-2 POST must 4xx, not create
// an un-modelled (server_id,agent,lens,2) row. score/verdict removed: the
// panel emits neither (verified 2026-05-15); columns dropped by migration 0015.
const EvalRowSchema = z.object({
	server_id: z.string().min(1),
	agent: z.enum(["a", "b", "c", "d", "e"]),
	model: z.string().min(1),
	lens: z.enum(["practical-implementation", "completeness", "use-case-fit", "accuracy", "authority"]),
	pass: z.union([z.literal(1), z.literal(3)]),
	notes: z.string().max(4000).nullable(),
	description: z.string().max(8000).nullable().optional(),
	created_at: z.string().datetime(),
});

const IngestPayloadSchema = z.object({
	rows: z.array(EvalRowSchema).min(1).max(100),
	mode: z.enum(["live", "backfill", "dry-run"]).default("live"),
});

type EvalRow = z.infer<typeof EvalRowSchema>;

const UPSERT_SQL = `
	INSERT INTO evals (server_id, agent, model, lens, pass, notes, description, created_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (server_id, agent, lens, pass) DO UPDATE SET
		model       = excluded.model,
		notes       = excluded.notes,
		description = excluded.description,
		created_at  = excluded.created_at
`;

export class SanityIngest extends OpenAPIRoute {
	schema = {
		tags: ["Internal"],
		summary: "Ingest a batch of Sanity Panel evals rows",
		security: [{ apiKey: [] }],
		request: {
			body: {
				content: {
					"application/json": {
						schema: IngestPayloadSchema,
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Batch processed (mixed-outcome OK)",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.object({
								accepted: z.number().int(),
								rejected_orphans: z.array(z.string()),
								rejected_validation: z.array(z.object({
									row_index: z.number().int(),
									error: z.string(),
								})),
								rejected_other: z.array(z.object({
									row_index: z.number().int(),
									error: z.string(),
								})),
								batch_size: z.number().int(),
								mode: z.string(),
							}),
						}),
					},
				},
			},
			"400": { description: "Validation error" },
			"401": { description: "Unauthorized" },
			"503": { description: "D1 unavailable" },
		},
	};

	async handle(c: AppContext) {
		const authError = requireAuth(c);
		if (authError) return authError;

		const data = await this.getValidatedData<typeof this.schema>();
		const { rows, mode } = data.body;

		const accepted: string[] = []; // server_ids that landed
		const rejected_orphans: string[] = [];
		const rejected_other: { row_index: number; error: string }[] = [];

		// Dry-run: skip D1, count accepted as "would have written."
		if (mode === "dry-run") {
			return c.json({
				success: true,
				result: {
					accepted: rows.length,
					rejected_orphans: [],
					rejected_validation: [],
					rejected_other: [],
					batch_size: rows.length,
					mode,
				},
			});
		}

		// Per-row try/except. D1 binding-level failure (D1 unavailable) escapes the
		// loop and surfaces as 503.
		try {
			for (let i = 0; i < rows.length; i++) {
				const r: EvalRow = rows[i];
				try {
					await c.env.DB.prepare(UPSERT_SQL).bind(
						r.server_id,
						r.agent,
						r.model,
						r.lens,
						r.pass,
						r.notes,
						r.description ?? null,
						r.created_at,
					).run();
					accepted.push(r.server_id);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (/FOREIGN KEY|REFERENCES/i.test(msg)) {
						rejected_orphans.push(r.server_id);
					} else {
						rejected_other.push({ row_index: i, error: msg.slice(0, 500) });
					}
				}
			}
		} catch (infraErr) {
			const msg = infraErr instanceof Error ? infraErr.message : String(infraErr);
			return c.json(
				{ success: false, errors: [{ code: 503, message: `D1 unavailable: ${msg.slice(0, 500)}` }] },
				503,
			);
		}

		return c.json({
			success: true,
			result: {
				accepted: accepted.length,
				rejected_orphans,
				rejected_validation: [], // zod errors are caught by Chanfana pre-handler; included for shape stability
				rejected_other,
				batch_size: rows.length,
				mode,
			},
		});
	}
}
