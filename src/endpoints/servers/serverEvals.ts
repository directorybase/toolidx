/**
 * GET /v1/servers/:id/evals
 *
 * Returns the multi-agent Sanity Panel evals for a server: raw rows plus an
 * aggregate computed from Pass-3 (final) scores.
 *
 * Spec: outputs/2026-05-11-claude-toolidx-multi-agent-review-surface-plan-v5.md §3.4
 *
 * Public read. No auth. 404 if the server does not exist; 200 with rows=[]
 * and aggregate=null if the server exists but has no panel data yet.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../../types";
import { selectComposite } from "../../lib/composite";

type EvalRow = {
	agent: string;
	model: string;
	lens: string;
	pass: number;
	score: number | null;
	verdict: string | null;
	notes: string | null;
	description: string | null;
	created_at: string;
};

export class ServerEvals extends OpenAPIRoute {
	schema = {
		tags: ["Servers"],
		summary: "Get the 5-agent Sanity Panel evals for a server",
		request: {
			params: z.object({
				id: z.string(),
			}),
		},
		responses: {
			"200": {
				description: "Evals rows + aggregate + composite (may be empty)",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							result: z.object({
								rows: z.array(z.object({
									agent: z.string(),
									model: z.string(),
									lens: z.string(),
									pass: z.number().int(),
									score: z.number().nullable(),
									verdict: z.string().nullable(),
									notes: z.string().nullable(),
									description: z.string().nullable(),
									created_at: z.string(),
								})),
								aggregate: z.object({
									agent_count: z.number().int(),
									pass: z.number().int(),
									mean_score: z.number(),
									score_spread: z.number(),
									verdict_split: z.object({
										approve: z.number().int(),
										revise: z.number().int(),
										reject: z.number().int(),
									}),
								}).nullable(),
								composite: z.object({
									text: z.string(),
									source: z.object({
										agent: z.string(),
										model: z.string().nullable(),
										pass: z.number().int().nullable(),
										lens: z.string(),
										score: z.number().nullable(),
									}),
									consensus: z.enum(["high", "mixed", "contested"]).nullable(),
									concerns: z.array(z.object({
										agent: z.string(),
										lens: z.string(),
										verdict: z.enum(["revise", "reject"]),
										note_excerpt: z.string(),
									})),
								}).nullable(),
							}),
						}),
					},
				},
			},
			"404": { description: "Server not found" },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { id } = data.params;

		// 404 vs. empty distinction: check server existence first; also pull
		// composite_override for §3.7 selection.
		const serverRow = await c.env.DB.prepare(
			"SELECT id, composite_override FROM servers WHERE id = ?"
		).bind(id).first<{ id: string; composite_override: string | null }>();
		if (!serverRow) {
			return c.json(
				{ success: false, errors: [{ code: 404, message: "Not found" }] },
				404,
			);
		}

		const rowsRes = await c.env.DB.prepare(
			`SELECT agent, model, lens, pass, score, verdict, notes, description, created_at
			 FROM evals WHERE server_id = ?
			 ORDER BY agent, lens, pass`
		).bind(id).all<EvalRow>();

		const rows: EvalRow[] = rowsRes.results ?? [];
		const aggregate = computeAggregate(rows);
		const composite = selectComposite(rows, serverRow.composite_override ?? null);

		return { success: true, result: { rows, aggregate, composite } };
	}
}

function computeAggregate(rows: EvalRow[]) {
	const pass3 = rows.filter(r => r.pass === 3);
	if (pass3.length === 0) return null;
	const scored = pass3.filter(r => typeof r.score === "number") as Array<EvalRow & { score: number }>;
	if (scored.length === 0) return null;
	const scores = scored.map(r => r.score);
	const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const agents = new Set(pass3.map(r => r.agent));
	const verdict_split = { approve: 0, revise: 0, reject: 0 };
	for (const r of pass3) {
		if (r.verdict === "approve" || r.verdict === "revise" || r.verdict === "reject") {
			verdict_split[r.verdict]++;
		}
	}
	return {
		agent_count: agents.size,
		pass: 3,
		mean_score: round2(mean),
		score_spread: round2(max - min),
		verdict_split,
	};
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
