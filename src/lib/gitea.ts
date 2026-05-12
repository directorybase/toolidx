// Shared Gitea base URL + repo identifiers for Worker-side fetches.
// Spec: outputs/2026-05-11-claude-toolidx-multi-agent-review-surface-plan-v5.md §3.3
//
// IMPORTANT: this is a LAN IP, not Tailscale. Cloudflare Workers fetch() runs in
// CF's network and does NOT have a Tailscale stack — the operator's Tailscale-only
// rule applies to workstation-side targeting, not Worker fetch. qc-archive
// (src/endpoints/servers/qcArchive.ts) ships against this same URL today.
export const GITEA_BASE = "http://192.168.7.70:30008";

// agenticwatch-results: where the QC archive writes final-pass run docs.
export const GITEA_RESULTS_OWNER = "gitea_admin";
export const GITEA_RESULTS_REPO = "agenticwatch-results";

// agenticwatch-jobs: where the 5-agent Sanity Panel writes per-job crosscheck/status.json.
// Default branch is `main` (verified 2026-05-11 against /api/v1/repos/.../branches).
export const GITEA_JOBS_OWNER = "gitea_admin";
export const GITEA_JOBS_REPO = "agenticwatch-jobs";
export const GITEA_JOBS_BRANCH = "main";
