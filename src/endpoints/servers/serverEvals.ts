/**
 * GET /v1/servers/:id/evals
 *
 * Returns the multi-agent Sanity Panel evals for a server: raw rows, a
 * coverage summary, and the composite description. v11: the panel emits no
 * score/verdict at any pass, so there is no mean/spread/verdict aggregate —
 * coverage states how much of the 5-agent panel landed.
 *
 * Spec: outputs/2026-05-15-claude-toolidx-multi-agent-review-surface-plan-v11.md §3.3, §4
 *
 * Public read. No auth. 404 if the server does not exist; 200 with rows=[]
 * and coverage.agents_with_pass3=0 if the server exists but has no panel data.
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
				description: "Evals rows + coverage + composite (may be empty)",
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
									notes: z.string().nullable(),
									description: z.string().nullable(),
									created_at: z.string(),
								})),
								// v11: the panel emits no score/verdict, so there is no
								// mean/spread/verdict aggregate. coverage states how much
								// of the 5-agent panel landed. Always present (never null).
								coverage: z.object({
									agents_with_pass3: z.number().int(),
									agents_total: z.number().int(),
									passes_present: z.array(z.number().int()),
								}),
								composite: z.object({
									text: z.string(),
									source: z.object({
										agent: z.string(),
										model: z.string().nullable(),
										pass: z.number().int().nullable(),
										lens: z.string(),
									}),
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
			`SELECT agent, model, lens, pass, notes, description, created_at
			 FROM evals WHERE server_id = ?
			 ORDER BY agent, lens, pass`
		).bind(id).all<EvalRow>();

		const rows: EvalRow[] = rowsRes.results ?? [];
		const coverage = computeCoverage(rows);
		const composite = selectComposite(rows, serverRow.composite_override ?? null);

		return { success: true, result: { rows, coverage, composite } };
	}
}

/**
 * v11 §4: coverage replaces the score/verdict aggregate. agents_total is the
 * literal 5-agent panel size; agents_with_pass3 is how many distinct agents
 * have a Pass-3 row; passes_present is the sorted distinct pass set (⊆ [1,3]).
 */
function computeCoverage(rows: EvalRow[]) {
	const agentsWithPass3 = new Set(rows.filter(r => r.pass === 3).map(r => r.agent));
	const passes = Array.from(new Set(rows.map(r => r.pass))).sort((a, b) => a - b);
	return {
		agents_with_pass3: agentsWithPass3.size,
		agents_total: 5,
		passes_present: passes,
	};
}
