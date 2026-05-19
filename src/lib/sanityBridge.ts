/**
 * Worker-native bridge from Gitea agenticwatch-jobs → toolidx evals.
 *
 * Spec: outputs/2026-05-15-claude-toolidx-multi-agent-review-surface-plan-v11.md
 *       §3.0 Phase 1, §3.1
 *
 * Invoked from the scheduled() handler in src/index.ts on a 15-minute cron.
 *
 * Algorithm (v11 — real file layout, verified live 2026-05-15):
 *   1. List job dirs via Gitea contents API (paginated).
 *   2. For each job: fetch describe.job.json → product_url → deriveServerId.
 *   3. Fetch crosscheck/status.json — a COMPLETION LEDGER, used purely as a
 *      fetch index (NOT a data source). Shape: { agent_a:{pass1:true,
 *      pass3:true,…}, …, ready_to_publish, … }.
 *   4. List crosscheck/ to enumerate agent_{a..e} dirs. For each agent:
 *      fetch agent_{x}/pass1.json ALWAYS; fetch agent_{x}/pass3.json ONLY
 *      when status.json agent_x.pass3 === true (skip the GET otherwise —
 *      logged in dry-run for AC-BRIDGE).
 *   5. Emit one evals row per (agent, lens, pass∈{1,3}). lens is derived
 *      from agent letter via AGENT_TO_LENS (the pipeline emits no lens,
 *      no score, no verdict at any pass — verified). description comes from
 *      the pass file; created_at = the file's written_at.
 *   6. In live mode, UPSERT batches via DB binding; in dry-run, log only.
 *
 * status.json never yields a row — it is an index, not content. The bridge
 * writes no score/verdict: the pipeline emits neither, the columns are dropped
 * by migration 0015, and the score-mean refresh that consumed them was deleted
 * (it had no inputs), per v11 §3.0 invariant B.
 */

import { deriveServerId } from "./id";
import { AGENT_TO_LENS, type AgentLetter } from "./composite";
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
	// have a 30s CPU-time soft limit on the free tier (longer on paid). v11 §3.1:
	// ~6–11 Gitea GETs/job (1 status + 1 crosscheck listing + ≤5 pass1 + ≤5 pass3).
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
}

// Lens vocabulary is owned by AGENT_TO_LENS in composite.ts (single source of
// truth, v11 §2). Agent letters are its keys. Pass is {1,3} only — pass-2
// files are reviewer→reviewee cross-reviews, out of scope (v11 §8 Q1).
type Lens = (typeof AGENT_TO_LENS)[AgentLetter];
type Pass = 1 | 3;

interface NormalizedRow {
	server_id: string;
	agent: AgentLetter;
	model: string;
	lens: Lens;
	pass: Pass;
	description: string | null;
	created_at: string;
}

// v11: the panel emits no score/verdict (columns dropped by migration 0015)
// and no notes in v1 (pass-2 cross-reviews dropped, §8 Q1). The bridge writes
// only the columns it has real data for; score/verdict/notes default NULL
// while the columns still exist (pre-0015) and are gone after.
const UPSERT_SQL = `
	INSERT INTO evals (server_id, agent, model, lens, pass, description, created_at)
	VALUES (?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (server_id, agent, lens, pass) DO UPDATE SET
		model       = excluded.model,
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

		// 3. crosscheck/status.json — COMPLETION LEDGER, used only as a fetch index.
		const status = await fetchJobJson(env.GITEA_TOKEN, jobName, "crosscheck/status.json");

		// 4 + 5. Walk agent_{x}/pass{1,3}.json and normalize.
		let rows: NormalizedRow[];
		try {
			rows = await normalizeJob(env.GITEA_TOKEN, jobName, serverId, status, mode);
		} catch (err) {
			result.jobs_normalizer_failed++;
			console.warn(
				`sanity-bridge: normalizer failed for job=${jobName} server=${serverId}:`,
				err instanceof Error ? err.message : String(err),
			);
			continue;
		}

		if (rows.length === 0) continue;
		result.jobs_with_status++; // jobs that produced ≥1 row
		allRows.push(...rows);
		touchedServerIds.add(serverId);
	}

	result.evals_rows_total = allRows.length;
	console.log(
		`sanity-bridge: normalized ${allRows.length} rows across ${touchedServerIds.size} servers ` +
		`(${result.jobs_with_status}/${result.jobs_listed} jobs produced rows, ` +
		`${result.jobs_normalizer_failed} normalizer failures)`,
	);

	if (mode === "dry-run") {
		console.log("sanity-bridge: DRY-RUN sample (first 3):", JSON.stringify(allRows.slice(0, 3), null, 2));
		// AC-BRIDGE: surface one description sample per (agent, pass) tuple plus
		// the derived lens so the operator can verify capture + lens mapping
		// before flipping to live mode.
		const seen = new Set<string>();
		const descSamples: Array<Pick<NormalizedRow, "agent" | "pass" | "lens" | "description">> = [];
		for (const r of allRows) {
			const k = `${r.agent}/${r.pass}`;
			if (seen.has(k)) continue;
			seen.add(k);
			descSamples.push({ agent: r.agent, pass: r.pass, lens: r.lens, description: r.description });
		}
		console.log(
			"sanity-bridge: DRY-RUN description samples per (agent, pass) [lens must match AGENT_TO_LENS]:",
			JSON.stringify(descSamples, null, 2),
		);
		return result;
	}

	// 6. UPSERT in chunks of 100 via D1 binding.
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

	result.server_ids_touched = touchedServerIds.size;

	console.log(
		`sanity-bridge: done — upserted=${result.evals_rows_upserted} ` +
		`orphans=${result.evals_rows_orphaned} servers=${result.server_ids_touched}`,
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

/** List the crosscheck/ directory of a job → the agent_{a..e} subdir names present. */
async function listCrosscheckAgentDirs(token: string, jobName: string): Promise<string[]> {
	const url =
		`${GITEA_BASE}/api/v1/repos/${GITEA_JOBS_OWNER}/${GITEA_JOBS_REPO}` +
		`/contents/jobs/${encodeURIComponent(jobName)}/crosscheck?ref=${GITEA_JOBS_BRANCH}`;
	const resp = await fetch(url, { headers: { Authorization: `token ${token}` } });
	if (!resp.ok) {
		if (resp.status !== 404) {
			console.warn(`sanity-bridge: listCrosscheck ${jobName} HTTP ${resp.status}`);
		}
		return [];
	}
	const entries = await resp.json<GiteaContentEntry[]>();
	if (!Array.isArray(entries)) return [];
	return entries
		.filter(e => e.type === "dir" && /^agent_[a-e]$/.test(e.name))
		.map(e => e.name);
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
 * Normalize one job's crosscheck/ tree into evals rows (v11 §3.1).
 *
 * Per agent_{x} dir present in crosscheck/:
 *   - lens   = AGENT_TO_LENS[letter]   (the pipeline emits no lens)
 *   - pass1  = fetched ALWAYS → one row, pass=1
 *   - pass3  = fetched ONLY when status.json agent_x.pass3 === true → one
 *              row, pass=3. When the flag is false/absent the GET is SKIPPED
 *              and the skip is logged in dry-run (AC-BRIDGE fetch-skip proof).
 *
 * status.json itself yields zero rows — it is a completion ledger / index.
 * score / verdict are always null (pipeline emits none). description and
 * created_at(=written_at) come from the pass file.
 *
 * Halt signal (dry-run review, v11 §3.0): if status says pass3:true but the
 * pass3.json GET 404s, a WARN is logged — the layout differs from §1 and the
 * operator must NOT flip BRIDGE_MODE=live.
 */
export async function normalizeJob(
	token: string,
	jobName: string,
	serverId: string,
	status: unknown,
	mode: BridgeMode,
): Promise<NormalizedRow[]> {
	const out: NormalizedRow[] = [];
	const fallbackTs = new Date().toISOString();

	const statusObj =
		status && typeof status === "object" ? (status as Record<string, unknown>) : null;

	const agentDirs = await listCrosscheckAgentDirs(token, jobName);
	if (agentDirs.length === 0) return out;

	for (const dir of agentDirs) {
		const letter = dir.replace(/^agent_/, "") as AgentLetter;
		const lens = AGENT_TO_LENS[letter];
		if (!lens) continue; // dir name not in the a–e map; skip defensively

		// pass1.json — always fetched.
		const p1 = await fetchJobJson(token, jobName, `crosscheck/${dir}/pass1.json`);
		const r1 = coercePassFile(serverId, letter, lens, 1, p1, fallbackTs);
		if (r1) out.push(r1);

		// pass3.json — gated on the status.json completion flag.
		const agentLedger =
			statusObj && typeof statusObj[`agent_${letter}`] === "object"
				? (statusObj[`agent_${letter}`] as Record<string, unknown>)
				: null;
		const pass3Done = agentLedger?.pass3 === true;

		if (!pass3Done) {
			if (mode === "dry-run") {
				console.log(
					`sanity-bridge: job=${jobName} agent=${letter} pass3 SKIPPED ` +
					`(status.agent_${letter}.pass3=${agentLedger ? "false" : "absent"}) — no GET issued`,
				);
			}
			continue;
		}

		const p3 = await fetchJobJson(token, jobName, `crosscheck/${dir}/pass3.json`);
		if (p3 === null) {
			// status said pass3:true but the file is missing → layout mismatch.
			console.warn(
				`sanity-bridge: HALT-SIGNAL job=${jobName} agent=${letter} — ` +
				`status.pass3=true but crosscheck/${dir}/pass3.json is absent; ` +
				`layout differs from v11 §1 (do NOT flip BRIDGE_MODE=live)`,
			);
			continue;
		}
		const r3 = coercePassFile(serverId, letter, lens, 3, p3, fallbackTs);
		if (r3) out.push(r3);
	}

	return out;
}

/**
 * One pass{1,3}.json → one NormalizedRow. The file shape (verified live):
 * { listing_id, agent_id, pass, focus, model, description, written_at[,
 *   pass1_description, critiques_received] }. No score/verdict/lens.
 */
function coercePassFile(
	serverId: string,
	letter: AgentLetter,
	lens: Lens,
	pass: Pass,
	raw: unknown,
	fallbackTs: string,
): NormalizedRow | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	return {
		server_id: serverId,
		agent: letter,
		model: pickString(r.model, "unknown"),
		lens,
		pass,
		description: pickNullableString(r.description, 8000),
		created_at: pickString(r.written_at, fallbackTs),
	};
}

// ── pickers ──────────────────────────────────────────────────────────────

function pickString(...candidates: unknown[]): string {
	for (const c of candidates) {
		if (typeof c === "string" && c.length > 0) return c;
	}
	return "";
}

function pickNullableString(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null;
	return v.slice(0, max);
}
