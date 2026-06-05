/**
 * Composite description selection for the 5-agent Sanity Panel.
 *
 * Spec: outputs/2026-05-12-claude-toolidx-multi-agent-review-surface-plan-v6.md §3.7
 *
 * Selection heuristic — primary-lens priority (operator-curated, NOT
 * score-weighted). For each lens in LENS_PRIORITY order, take the Pass-3
 * row owning that lens if its score ≥ MIN_SCORE and verdict ≠ "reject".
 * If all five fall through, return null and let the page fall back to
 * server.description.
 *
 * Operator override via servers.composite_override TEXT: when set, that
 * string becomes the composite verbatim. Source attribution becomes
 * "operator-curated".
 *
 * Computed on read (not stored). Cost: one filter pass over rows already
 * fetched for the page.
 */

export const LENS_PRIORITY = [
	"practical-implementation",
	"completeness",
	"use-case-fit",
	"accuracy",
	"authority",
] as const;

/**
 * Single source of truth: Sanity Panel agent letter → lens.
 * Confirmed via crosscheck_agent.py AGENT_FOCUS (agenticwatch-workers, branch
 * `master`): a→accuracy, b→use-case-fit, c→completeness,
 * d→practical-implementation, e→authority. The pipeline emits NO lens field;
 * lens is derived from agent identity only. Plan v11 §1/§2.
 */
export const AGENT_TO_LENS = {
	a: "accuracy",
	b: "use-case-fit",
	c: "completeness",
	d: "practical-implementation",
	e: "authority",
} as const;

export type AgentLetter = keyof typeof AGENT_TO_LENS;

// v11: the Sanity Panel emits NO score and NO verdict at any pass (verified
// live 2026-05-15). The score≥MIN_SCORE / verdict≠reject gate and the
// consensus/concerns surfaces had no inputs and are deleted. Selection is
// lens-priority over Pass-3 rows that carry a non-empty description.

export type EvalRowForComposite = {
	agent: string;
	model: string;
	lens: string;
	pass: number;
	description: string | null;
};

export type CompositeSource = {
	agent: string;
	model: string | null;
	pass: number | null;
	lens: string;
};

export type Composite = {
	text: string;
	source: CompositeSource;
};

/**
 * Pure heuristic; no LLM. Stable for given rows + override (v11 §7).
 *   override non-empty → { text: override, source: operator-curated }
 *   else: first Pass-3 row with a non-empty description, in LENS_PRIORITY order
 *   else: null → page falls back to server.description
 */
export function selectComposite(
	rows: EvalRowForComposite[],
	override: string | null,
): Composite | null {
	if (override && override.length > 0) {
		return {
			text: override,
			source: { agent: "operator", model: null, pass: null, lens: "operator-curated" },
		};
	}

	const pass3Rows = rows.filter(
		(r) => r.pass === 3 && typeof r.description === "string" && r.description.length > 0,
	);

	for (const lens of LENS_PRIORITY) {
		const candidate = pass3Rows.find((r) => r.lens === lens);
		if (candidate) {
			return {
				text: candidate.description!,
				source: {
					agent: candidate.agent,
					model: candidate.model,
					pass: 3,
					lens: candidate.lens,
				},
			};
		}
	}

	return null;
}
