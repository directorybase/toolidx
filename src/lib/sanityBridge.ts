/**
 * Worker-native bridge from Gitea agenticwatch-jobs → toolidx evals.
 *
 * Spec: outputs/2026-05-11-claude-toolidx-multi-agent-review-surface-plan-v5.md §3.3
 *
 * Invoked from the scheduled() handler in src/index.ts on a 15-minute cron.
 *
 * Algorithm:
 *   1. List job dirs via Gitea contents API (paginated).
 *   2. For each job: fetch describe.job.json → product_url → deriveServerId.
 *   3. Attempt crosscheck/status.json; skip 404s.
 *   4. Normalize to evals rows (agent × lens × pass).
 *   5. In live mode, UPSERT batches via DB binding; in dry-run mode, log only.
 *   6. After all batches, refresh rollups for distinct server_ids.
 *
 * Normalizer resilience: a job with a malformed status.json is logged and
 * skipped — the run continues. The status.json shape is best-effort: this
 * implementation tries several plausible field paths; gaps are surfaced in
 * dry-run mode logs before any live writes.
 */

import { deriveServerId } from "./id";
import { refreshRollups } from "./rollup";
import {
	GITEA_BASE,
	GITEA_JOBS_OWNER,
	GITEA_JOBS_REPO,
	GITEA_JOBS_BRANCH,
} from "./gitea";

type Bindings = {
	DB: D1Database;
	GITEA_TOKEN: string;
};

export type BridgeMode = "live" | "dry-run";

export interface BridgeOpts {
	mode: BridgeMode;
	// Hard cap on job dirs processed per invocation. Cloudflare scheduled handlers
	// have a 30s CPU-time soft limit on the free tier (longer on paid); 300 jobs
	// × 2 Gitea GETs each is well within budget but caps prevent runaway pages.
	maxJobs?: number;
}

export interface BridgeResult {
	mode: BridgeMode;
	jobs_listed: number;
	jobs_with_describe: number;
	jobs_with_status: number;
	jobs_normalizer_failed: number;
	evals_rows_total: number;
	evals_rows_upserted: number;
	evals_rows_orphaned: number;
	server_ids_touched: number;
	rollups_refreshed: number;
}

// Lens vocabulary aligned to v6 §3.7 + crosscheck_agent.py + the operator-reviewed
// preview-review-block.html. v5 shipped a placeholder enum; v6 makes the names
// load-bearing because composite selection keys off lens identity.
const LENSES = ["practical-implementation", "completeness", "use-case-fit", "accuracy", "authority"] as const;
const AGENTS = ["a", "b", "c", "d", "e"] as const;
const PASSES = [1, 2, 3] as const;

type Lens = (typeof LENSES)[number];
type Agent = (typeof AGENTS)[number];
type Pass = (typeof PASSES)[number];

interface NormalizedRow {
	server_id: string;
	agent: Agent;
	model: string;
	lens: Lens;
	pass: Pass;
	score: number | null;
	verdict: "approve" | "revise" | "reject" | null;
	notes: string | null;
	description: string | null;
	created_at: string;
}

const UPSERT_SQL = `
	INSERT INTO evals (server_id, agent, model, lens, pass, score, verdict, notes, description, created_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (server_id, agent, lens, pass) DO UPDATE SET
		model       = excluded.model,
		score       = excluded.score,
		verdict     = excluded.verdict,
		notes       = excluded.notes,
		description = excluded.description,
		created_at  = excluded.created_at
`;

/** Public entry point — called by scheduled() handler. */
export async function runSanityBridge(
	env: Bindings,
	opts: BridgeOpts,
): Promise<BridgeResult> {
	const { mode } = opts;
	const maxJobs = opts.maxJobs ?? 500;

	if (!env.GITEA_TOKEN) {
		console.error("sanity-bridge: GITEA_TOKEN not set; aborting");
		return zeroResult(mode);
	}

	console.log(`sanity-bridge: starting run mode=${mode} maxJobs=${maxJobs}`);

	const result: BridgeResult = zeroResult(mode);
	const touchedServerIds = new Set<string>();

	// 1. Page through jobs/ contents.
	const jobDirs = await listJobDirs(env.GITEA_TOKEN, maxJobs);
	result.jobs_listed = jobDirs.length;
	console.log(`sanity-bridge: listed ${jobDirs.length} job dirs`);

	const allRows: NormalizedRow[] = [];

	for (const jobName of jobDirs) {
		// 2. describe.job.json — derive server_id
		const describe = await fetchJobJson(env.GITEA_TOKEN, jobName, "describe.job.json");
		if (!describe) continue;
		result.jobs_with_describe++;

		const productUrl = (describe as Record<string, unknown>).product_url;
		if (typeof productUrl !== "string" || productUrl.length === 0) continue;
		const serverId = deriveServerId(productUrl);

		// 3. crosscheck/status.json — the Sanity Panel output
		const status = await fetchJobJson(env.GITEA_TOKEN, jobName, "crosscheck/status.json");
		if (!status) continue;
		result.jobs_with_status++;

		// 4. Normalize
		let rows: NormalizedRow[];
		try {
			rows = normalizeStatus(serverId, status);
		} catch (err) {
			result.jobs_normalizer_failed++;
			console.warn(
				`sanity-bridge: normalizer failed for job=${jobName} server=${serverId}:`,
				err instanceof Error ? err.message : String(err),
			);
			continue;
		}

		if (rows.length === 0) continue;
		allRows.push(...rows);
		touchedServerIds.add(serverId);
	}

	result.evals_rows_total = allRows.length;
	console.log(
		`sanity-bridge: normalized ${allRows.length} rows across ${touchedServerIds.size} servers ` +
		`(${result.jobs_with_status}/${result.jobs_listed} jobs had status.json, ` +
		`${result.jobs_normalizer_failed} normalizer failures)`,
	);

	if (mode === "dry-run") {
		// Log a small sample for operator inspection.
		console.log("sanity-bridge: DRY-RUN sample (first 3):", JSON.stringify(allRows.slice(0, 3), null, 2));
		// v6: surface one description sample per encountered (agent, pass) tuple so
		// operator can verify description capture before flipping to live mode.
		const seen = new Set<string>();
		const descSamples: Array<Pick<NormalizedRow, "agent" | "pass" | "lens" | "description">> = [];
		for (const r of allRows) {
			const k = `${r.agent}/${r.pass}`;
			if (seen.has(k)) continue;
			seen.add(k);
			descSamples.push({ agent: r.agent, pass: r.pass, lens: r.lens, description: r.description });
		}
		console.log(
			"sanity-bridge: DRY-RUN description samples per (agent, pass):",
			JSON.stringify(descSamples, null, 2),
		);
		return result;
	}

	// 5. UPSERT in chunks of 100 via D1 binding.
	for (let i = 0; i < allRows.length; i += 100) {
		const chunk = allRows.slice(i, i + 100);
		for (const r of chunk) {
			try {
				await env.DB.prepare(UPSERT_SQL).bind(
					r.server_id,
					r.agent,
					r.model,
					r.lens,
					r.pass,
					r.score,
					r.verdict,
					r.notes,
					r.description,
					r.created_at,
				).run();
				result.evals_rows_upserted++;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (/FOREIGN KEY|REFERENCES/i.test(msg)) {
					result.evals_rows_orphaned++;
				} else {
					console.warn(`sanity-bridge: row upsert failed for ${r.server_id}/${r.agent}/${r.lens}/${r.pass}:`, msg);
				}
			}
		}
	}

	// 6. Refresh rollups for distinct touched servers.
	const idsArr = Array.from(touchedServerIds);
	try {
		await refreshRollups(env.DB, idsArr);
		result.rollups_refreshed = idsArr.length;
	} catch (err) {
		console.error(
			"sanity-bridge: refreshRollups failed:",
			err instanceof Error ? err.message : String(err),
		);
	}
	result.server_ids_touched = idsArr.length;

	console.log(
		`sanity-bridge: done — upserted=${result.evals_rows_upserted} ` +
		`orphans=${result.evals_rows_orphaned} rollups=${result.rollups_refreshed}`,
	);
	return result;
}

function zeroResult(mode: BridgeMode): BridgeResult {
	return {
		mode,
		jobs_listed: 0,
		jobs_with_describe: 0,
		jobs_with_status: 0,
		jobs_normalizer_failed: 0,
		evals_rows_total: 0,
		evals_rows_upserted: 0,
		evals_rows_orphaned: 0,
		server_ids_touched: 0,
		rollups_refreshed: 0,
	};
}

interface GiteaContentEntry {
	name: string;
	type: "file" | "dir" | "symlink";
}

async function listJobDirs(token: string, maxJobs: number): Promise<string[]> {
	const out: string[] = [];
	let page = 1;
	const limit = 50;
	while (out.length < maxJobs) {
		const url =
			`${GITEA_BASE}/api/v1/repos/${GITEA_JOBS_OWNER}/${GITEA_JOBS_REPO}` +
			`/contents/jobs?ref=${GITEA_JOBS_BRANCH}&page=${page}&limit=${limit}`;
		const resp = await fetch(url, { headers: { Authorization: `token ${token}` } });
		if (!resp.ok) {
			console.warn(`sanity-bridge: listJobDirs page=${page} HTTP ${resp.status}`);
			break;
		}
		const entries = await resp.json<GiteaContentEntry[]>();
		if (!Array.isArray(entries) || entries.length === 0) break;
		for (const e of entries) {
			if (e.type === "dir") out.push(e.name);
			if (out.length >= maxJobs) break;
		}
		if (entries.length < limit) break; // last page
		page++;
	}
	return out;
}

async function fetchJobJson(
	token: string,
	jobName: string,
	relPath: string,
): Promise<unknown | null> {
	const url =
		`${GITEA_BASE}/api/v1/repos/${GITEA_JOBS_OWNER}/${GITEA_JOBS_REPO}` +
		`/raw/jobs/${encodeURIComponent(jobName)}/${relPath}?ref=${GITEA_JOBS_BRANCH}`;
	const resp = await fetch(url, { headers: { Authorization: `token ${token}` } });
	if (resp.status === 404) return null;
	if (!resp.ok) {
		console.warn(`sanity-bridge: fetchJobJson ${jobName}/${relPath} HTTP ${resp.status}`);
		return null;
	}
	try {
		return await resp.json();
	} catch (err) {
		console.warn(
			`sanity-bridge: JSON parse failed for ${jobName}/${relPath}:`,
			err instanceof Error ? err.message : String(err),
		);
		return null;
	}
}

/**
 * Normalize a status.json into evals rows.
 *
 * The Sanity Panel's exact field shape is hypothesis-only at this point (per
 * v5 §1) — the normalizer is best-effort and tolerant. It walks the document
 * looking for per-agent, per-lens, per-pass entries with score/verdict/notes.
 *
 * v6: each row also captures `description` per (agent, pass). Pass-1 typically
 * carries the blind first-write description; Pass-2 typically carries cross-
 * review notes only; Pass-3 typically carries the final-informed description.
 * When the source has no description string for an entry, the row gets
 * description=null and is ineligible as a composite-source candidate (§3.7).
 *
 * Tries these shapes (in order):
 *   A. status.passes[pass].agents[agent].lenses[lens] = { score, verdict, notes, description, model, created_at }
 *   B. status[agent].passes[pass].lenses[lens] = { score, verdict, notes, description, model, created_at }
 *   C. status.results[*] = { agent, pass, lens, score, verdict, notes, description, model, created_at }
 *
 * Each shape handler also looks one level up for a shape-level `description`
 * (e.g. agent-pass-level rather than lens-level) since some pass-emitters
 * record one description per (agent, pass) rather than one per (agent, pass, lens).
 * The lens-level value wins when both present.
 *
 * If none match, returns []. The dry-run mode is the place to discover the
 * real shape — logs will show empty normalizer output for jobs that don't fit.
 */
export function normalizeStatus(serverId: string, status: unknown): NormalizedRow[] {
	if (!status || typeof status !== "object") return [];
	const s = status as Record<string, unknown>;
	const out: NormalizedRow[] = [];

	// Default created_at for rows missing one — bridge sees data when it sees it.
	const fallbackTs = new Date().toISOString();

	// Shape C: flat results array.
	if (Array.isArray(s.results)) {
		for (const raw of s.results) {
			const row = coerceResultEntry(serverId, raw, fallbackTs);
			if (row) out.push(row);
		}
		if (out.length > 0) return out;
	}

	// Shape A: passes → agents → lenses.
	if (s.passes && typeof s.passes === "object") {
		const passes = s.passes as Record<string, unknown>;
		for (const passKey of Object.keys(passes)) {
			const pass = coercePass(passKey);
			if (pass === null) continue;
			const agentsBlock = passes[passKey];
			if (!agentsBlock || typeof agentsBlock !== "object") continue;
			const agentsObj = (agentsBlock as Record<string, unknown>).agents ?? agentsBlock;
			if (!agentsObj || typeof agentsObj !== "object") continue;
			for (const agentKey of Object.keys(agentsObj as Record<string, unknown>)) {
				const agent = coerceAgent(agentKey);
				if (!agent) continue;
				const lensBlock = (agentsObj as Record<string, unknown>)[agentKey];
				const lenses = (lensBlock as Record<string, unknown> | undefined)?.lenses
					?? lensBlock;
				if (!lenses || typeof lenses !== "object") continue;
				const model = (lensBlock as Record<string, unknown>)?.model;
				const created_at = (lensBlock as Record<string, unknown>)?.created_at;
				// Pass-emitters may record one description per (agent, pass)
				// at the agent-pass-block level rather than per lens.
				const agentPassDescription = (lensBlock as Record<string, unknown>)?.description;
				for (const lensKey of Object.keys(lenses as Record<string, unknown>)) {
					const lens = coerceLens(lensKey);
					if (!lens) continue;
					const cell = (lenses as Record<string, unknown>)[lensKey];
					if (!cell || typeof cell !== "object") continue;
					const c = cell as Record<string, unknown>;
					out.push({
						server_id: serverId,
						agent,
						model: pickString(c.model, model, "unknown"),
						lens,
						pass,
						score: pickNullableNumber(c.score),
						verdict: pickNullableVerdict(c.verdict),
						notes: pickNullableString(c.notes, 4000),
						description: pickNullableString(c.description ?? agentPassDescription, 8000),
						created_at: pickString(c.created_at, created_at, fallbackTs),
					});
				}
			}
		}
		if (out.length > 0) return out;
	}

	// Shape B: per-agent top-level.
	for (const agentKey of Object.keys(s)) {
		const agent = coerceAgent(agentKey);
		if (!agent) continue;
		const agentBlock = s[agentKey];
		if (!agentBlock || typeof agentBlock !== "object") continue;
		const passes = (agentBlock as Record<string, unknown>).passes;
		if (!passes || typeof passes !== "object") continue;
		const agentModel = (agentBlock as Record<string, unknown>).model;
		for (const passKey of Object.keys(passes as Record<string, unknown>)) {
			const pass = coercePass(passKey);
			if (pass === null) continue;
			const passBlock = (passes as Record<string, unknown>)[passKey];
			const lenses = (passBlock as Record<string, unknown> | undefined)?.lenses
				?? passBlock;
			if (!lenses || typeof lenses !== "object") continue;
			// Per (agent, pass) block-level description (some emitters write one
			// description per pass rather than per lens).
			const agentPassDescription = (passBlock as Record<string, unknown> | undefined)?.description;
			for (const lensKey of Object.keys(lenses as Record<string, unknown>)) {
				const lens = coerceLens(lensKey);
				if (!lens) continue;
				const cell = (lenses as Record<string, unknown>)[lensKey];
				if (!cell || typeof cell !== "object") continue;
				const c = cell as Record<string, unknown>;
				out.push({
					server_id: serverId,
					agent,
					model: pickString(c.model, agentModel, "unknown"),
					lens,
					pass,
					score: pickNullableNumber(c.score),
					verdict: pickNullableVerdict(c.verdict),
					notes: pickNullableString(c.notes, 4000),
					description: pickNullableString(c.description ?? agentPassDescription, 8000),
					created_at: pickString(c.created_at, fallbackTs),
				});
			}
		}
	}

	return out;
}

// ── coercers ─────────────────────────────────────────────────────────────

function coerceAgent(v: unknown): Agent | null {
	if (typeof v !== "string") return null;
	const lower = v.toLowerCase();
	if ((AGENTS as readonly string[]).includes(lower)) return lower as Agent;
	return null;
}

function coerceLens(v: unknown): Lens | null {
	if (typeof v !== "string") return null;
	const lower = v.toLowerCase();
	if ((LENSES as readonly string[]).includes(lower)) return lower as Lens;
	return null;
}

function coercePass(v: unknown): Pass | null {
	const n = typeof v === "number" ? v : parseInt(String(v).replace(/^pass[_-]?/i, ""), 10);
	if (n === 1 || n === 2 || n === 3) return n;
	return null;
}

function pickString(...candidates: unknown[]): string {
	for (const c of candidates) {
		if (typeof c === "string" && c.length > 0) return c;
	}
	return "";
}

function pickNullableNumber(v: unknown): number | null {
	if (typeof v === "number" && !Number.isNaN(v)) return Math.max(0, Math.min(10, v));
	return null;
}

function pickNullableVerdict(v: unknown): "approve" | "revise" | "reject" | null {
	if (typeof v !== "string") return null;
	const lower = v.toLowerCase();
	if (lower === "approve" || lower === "revise" || lower === "reject") return lower;
	return null;
}

function pickNullableString(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null;
	return v.slice(0, max);
}

function coerceResultEntry(serverId: string, raw: unknown, fallbackTs: string): NormalizedRow | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const agent = coerceAgent(r.agent);
	const lens = coerceLens(r.lens);
	const pass = coercePass(r.pass);
	if (!agent || !lens || pass === null) return null;
	return {
		server_id: serverId,
		agent,
		model: pickString(r.model, "unknown"),
		lens,
		pass,
		score: pickNullableNumber(r.score),
		verdict: pickNullableVerdict(r.verdict),
		notes: pickNullableString(r.notes, 4000),
		description: pickNullableString(r.description, 8000),
		created_at: pickString(r.created_at, fallbackTs),
	};
}
