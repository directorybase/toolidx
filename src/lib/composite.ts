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

export const MIN_SCORE = 5.0;

export type EvalRowForComposite = {
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

export type ConsensusTag = "high" | "mixed" | "contested" | null;

export type CompositeSource = {
	agent: string;
	model: string | null;
	pass: number | null;
	lens: string;
	score: number | null;
};

export type CompositeConcern = {
	agent: string;
	lens: string;
	verdict: "revise" | "reject";
	note_excerpt: string;
};

export type Composite = {
	text: string;
	source: CompositeSource;
	consensus: ConsensusTag;
	concerns: CompositeConcern[];
};

/** Pure heuristic; no LLM. Stable for given rows + override. */
export function selectComposite(
	rows: EvalRowForComposite[],
	override: string | null,
): Composite | null {
	if (override && override.length > 0) {
		return {
			text: override,
			source: { agent: "operator", model: null, pass: null, lens: "operator-curated", score: null },
			consensus: computeConsensus(rows),
			concerns: computeConcerns(rows),
		};
	}

	const pass3Rows = rows.filter(
		(r) => r.pass === 3 && typeof r.description === "string" && r.description.length > 0,
	);

	for (const lens of LENS_PRIORITY) {
		const candidate = pass3Rows.find(
			(r) =>
				r.lens === lens &&
				typeof r.score === "number" &&
				r.score >= MIN_SCORE &&
				r.verdict !== "reject",
		);
		if (candidate) {
			return {
				text: candidate.description!,
				source: {
					agent: candidate.agent,
					model: candidate.model,
					pass: 3,
					lens: candidate.lens,
					score: candidate.score,
				},
				consensus: computeConsensus(rows),
				concerns: computeConcerns(rows),
			};
		}
	}

	return null;
}

/**
 * Consensus tag — Pass-3 only.
 *   high       — all 5 distinct agents present and every Pass-3 verdict = approve
 *   mixed      — some "revise" but zero "reject"
 *   contested  — ≥ 1 "reject" in Pass 3
 *   null       — fewer than 5 distinct agents have Pass-3 data (incomplete panel)
 */
export function computeConsensus(rows: EvalRowForComposite[]): ConsensusTag {
	const pass3 = rows.filter((r) => r.pass === 3);
	const agents = new Set(pass3.map((r) => r.agent));
	if (agents.size < 5) return null;

	let anyReject = false;
	let anyRevise = false;
	for (const r of pass3) {
		if (r.verdict === "reject") anyReject = true;
		else if (r.verdict === "revise") anyRevise = true;
	}
	if (anyReject) return "contested";
	if (anyRevise) return "mixed";
	return "high";
}

/** Every Pass-3 row where verdict != "approve". One concern per dissenting row. */
export function computeConcerns(rows: EvalRowForComposite[]): CompositeConcern[] {
	const out: CompositeConcern[] = [];
	for (const r of rows) {
		if (r.pass !== 3) continue;
		if (r.verdict !== "revise" && r.verdict !== "reject") continue;
		const excerpt = typeof r.notes === "string" ? r.notes.slice(0, 200) : "";
		out.push({
			agent: r.agent,
			lens: r.lens,
			verdict: r.verdict,
			note_excerpt: excerpt,
		});
	}
	return out;
}
