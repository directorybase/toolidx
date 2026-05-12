// Refreshes per-server rollup columns from the evals table.
// Spec: outputs/2026-05-11-claude-toolidx-multi-agent-review-surface-plan-v5.md §3.6
//
// Called from sanityBridge.ts (after each batch loop) and sanityIngest.ts
// (after each HTTP batch when mode !== "dry-run").
//
// Option α (per-ingest refresh) — keeps quality_score / sanity_score current at
// near-real-time cost. One UPDATE per distinct server_id per batch.
//
// Formulas:
//   quality_score = mean over Pass-3 scores across all (agent, lens) tuples
//   sanity_score  = mean over Pass-1 scores across all (agent, lens) tuples
// Both null when no Pass-3 / Pass-1 data exists for that server.

export async function refreshRollups(db: D1Database, serverIds: string[]): Promise<void> {
	if (serverIds.length === 0) return;

	// Dedupe defensively — callers may pass duplicates.
	const uniqueIds = Array.from(new Set(serverIds));

	const stmt = db.prepare(`
		UPDATE servers SET
			quality_score = (SELECT AVG(score) FROM evals WHERE server_id = ?1 AND pass = 3 AND score IS NOT NULL),
			sanity_score  = (SELECT AVG(score) FROM evals WHERE server_id = ?1 AND pass = 1 AND score IS NOT NULL)
		WHERE id = ?1
	`);

	// Sequential is fine — worst-case ~500 UPDATEs per cron tick, well within budget.
	// batch() would parallelize but each UPDATE is independent so the perf gain is marginal.
	for (const id of uniqueIds) {
		await stmt.bind(id).run();
	}
}
