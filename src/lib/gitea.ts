// Shared Gitea base URL + repo identifiers for Worker-side fetches.
//
// Cloudflare Workers fetch() runs at the edge and CANNOT reach lab IPs (LAN
// 192.168.x or Tailscale 100.x — both non-routable from CF's network). The
// only reachable path is the public Cloudflare Tunnel hostname.
//
// Tunnel caveat (verified 2026-05-30): authed light calls return fast
// (`/branches/{name}` ~0.4s) but Gitea's `/contents/{dir}` API enriches each
// entry with last-commit metadata, which times out at >110s for `jobs/` (318
// entries). For heavy directory listings, use `/git/trees/{sha}` instead
// (no per-entry enrichment). See sanityBridge.ts listJobDirs.
export const GITEA_BASE = "https://gitea.agenticwatch.dev";

// agenticwatch-results: where the QC archive writes final-pass run docs.
export const GITEA_RESULTS_OWNER = "gitea_admin";
export const GITEA_RESULTS_REPO = "agenticwatch-results";

// agenticwatch-jobs: where the 5-agent Sanity Panel writes per-job crosscheck/status.json.
// Default branch is `main` (verified 2026-05-11 against /api/v1/repos/.../branches).
export const GITEA_JOBS_OWNER = "gitea_admin";
export const GITEA_JOBS_REPO = "agenticwatch-jobs";
export const GITEA_JOBS_BRANCH = "main";
