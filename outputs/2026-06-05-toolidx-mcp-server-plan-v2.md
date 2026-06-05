---
title: Public toolidx MCP Server With Payment Options
version: v2
supersedes: outputs/2026-06-05-toolidx-mcp-server-plan.md
---

# Public toolidx MCP Server With Payment Options (v2)

## 0. Cross-review responses (audit)

### Pass 1 — v1 → v2 (reviewers: codex accept-with-changes, gemini accept-with-changes)

| # | Must-fix | Raised by | Class | Addressed in |
|---|----------|-----------|-------|--------------|
| M1 | No explicit phase decomposition; independence/reversibility/ordering not established | codex+gemini | design | §2 Phased Decomposition |
| M2 | Durable Object export name, binding name, migration tag strategy, rollback unspecified | codex+gemini | design | §3 Key Changes; §2 Phase 1 |
| M3 | x402 flow: verification timing vs tool execution, failure response shape, production-enable checklist/guardrails, recipient+facilitator ownership, test-facilitator availability | codex | design | §6 Payment Design |
| M4 | Origin protection incomplete: missing/forged Origin, Host validation, DNS-rebinding, dev exceptions, CORS for MCP clients | codex+gemini | design | §7 Security & Transport |
| M5 | Transport ambiguous ("Streamable HTTP" in summary only); SSE/stdio/mcp-remote relationship unstated | codex+gemini | design | §7 Security & Transport |
| M6 | D1 query safety: prepared statements, SQL LIMIT, indexes/search strategy, filter behavior unspecified | codex+gemini | design | §8 Data Access |
| M7 | `/.well-known/mcp.json` "unchanged" claim conflicts with conditional edit; needs additive-only compatibility rule + transport pointer | codex+gemini | design | §9 Discovery |
| M8 | Ambiguous acceptance criteria ("valid content", "clear MCP error", "fails cleanly") | codex | design | §11 Test Plan |

Advisory (non-blocking, recorded): cold-start/script-size growth from `agents` SDK; new Durable Object cost line; x402 test-facilitator availability — folded into §6 and §12.

**User amendment (pre-review, v2):** operator directed adding an explicit
monetization goal (now G6 + §6.5) and inviting reviewers to propose other creative
monetization avenues. Applied before the pass-2 dispatch; the pass-2 review prompt
carries an added question (f) soliciting monetization critique + ideas.

---

## 1. Summary

Build a small remote MCP server for toolidx.dev at `https://toolidx.dev/mcp`,
hosted inside the existing Cloudflare Worker (Hono app, `export default { fetch,
scheduled }`), exposing a few agent-native tools over **Streamable HTTP** (see §7
for transport details). Keep core discovery free, add one paid premium tool path
(x402), and validate payments in test mode before enabling production charges.

Use the Cloudflare Agents SDK `McpAgent` rather than a plain REST wrapper because
Cloudflare's current paid MCP tooling is built around `withX402` / `paidTool`,
giving a direct upgrade path from free tools to per-call paid tools.

**Goals (graded in §11):** (G1) a live `/mcp` endpoint an agent can connect to
with no API key for free tools; (G2) decision-oriented free discovery tools over
existing D1 data; (G3) one paid risk-report tool, free in test mode, x402-gated in
payment-test mode; (G4) zero regression to existing `/v1/*`, `/openapi.json`,
`/llms.txt`, `/.well-known/*` surfaces; (G5) production charging stays disabled
until explicitly approved per the §6 production-enable checklist; (G6) **establish
a monetization path that turns the QC/curation work already invested in
toolidx.dev into recurring revenue** — the MCP paid tool is the first concrete
step, and §6.5 catalogs further candidate revenue lines for deliberate selection
(this release does not commit to all of them).

## 2. Phased Decomposition

Four independent, individually reversible phases in dependency order. Each phase
is shippable and revertible on its own; later phases depend only on earlier ones.

- **Phase 1 — Foundation (reversible: revert config + remove DO migration).**
  Add deps (`agents`, `@modelcontextprotocol/sdk`; reuse `zod`). Add the
  `ToolidxMcp` Durable Object binding + migration to `wrangler.jsonc`
  (`new_sqlite_classes`, see §3). Add the named `ToolidxMcp` export and wire the
  `/mcp` route into the Hono default export. Run `npx wrangler types`. Acceptance:
  `wrangler deploy --dry-run` succeeds; `/mcp` `initialize` returns a valid MCP
  server-info response; no existing route changes behavior.
  *Rollback:* delete the route + export + binding/migration; redeploy. Because
  the DO holds no durable business state in v1 (stateless query handlers), removal
  is safe.

- **Phase 2 — Free tools (reversible: unregister tools).** Implement the four free
  tools (§4) querying D1 per §8. Acceptance: tool list contains exactly the four
  free tools; each returns the §11 response shapes; excluded-status rows never
  appear. *Rollback:* unregister tools; Phase 1 endpoint still valid.

- **Phase 3 — Paid tool + payment (reversible: `X402_ENABLED=false`).** Register
  `get_install_risk_report`. With `X402_ENABLED=false` it is **free**; with
  `X402_ENABLED=true` it is `paidTool`-gated per §6. Acceptance: §11 payment tests
  pass on `base-sepolia`. *Rollback:* set `X402_ENABLED=false` (single env flip).

- **Phase 4 — Discovery & docs (reversible: revert additive edits).** Additively
  augment `/.well-known/mcp.json` (§9) and add user docs (§10). Acceptance: §11
  discovery + regression tests pass. *Rollback:* revert the additive JSON field
  and docs.

## 3. Key Changes

- Add MCP runtime dependencies: `agents`, `@modelcontextprotocol/sdk`; reuse
  existing `zod`.

- Add a `ToolidxMcp` class extending `McpAgent`, **exported as a named export from
  `src/index.ts`** (`export class ToolidxMcp extends McpAgent { ... }`) — required
  for Cloudflare to resolve the Durable Object.

- **Durable Object binding + migration in `wrangler.jsonc`:**
  - `durable_objects.bindings`: `{ "name": "MCP_OBJECT", "class_name": "ToolidxMcp" }`.
  - `migrations`: `{ "tag": "v1", "new_sqlite_classes": ["ToolidxMcp"] }`
    (McpAgent requires the SQLite-backed DO storage class).
  - Run `npx wrangler types` after the config change so `MCP_OBJECT` appears in
    `worker-configuration.d.ts`.

- **Route wiring (Hono coexistence).** The Worker's `export default` currently
  delegates `fetch` to `app.fetch` (Hono) and adds `scheduled`. Wire `/mcp` by
  having the top-level `fetch` route `/mcp` (and `/sse` if enabled, §7) to
  `ToolidxMcp.serve('/mcp')` / `serveSSE('/sse')` **before** delegating the
  remainder to `app.fetch`, so Hono continues to own all existing routes
  untouched. The `scheduled` handler is unchanged.

- Keep existing `/v1/*`, `/openapi.json`, `/llms.txt`, and `/.well-known/mcp.json`
  behavior unchanged except for the additive discovery field in §9.

## 4. MCP Tool Surface

Expose only decision-oriented tools, not every REST endpoint.

**Free tools:**

- `search_verified_servers` — Inputs: `query`, `limit`, optional filters:
  `package_type`, `requires_env_vars`, `hangs_on_start`, `is_proxy`. Output:
  compact ranked server summaries (`id`, `name`, `description`, `install_command`,
  `tool_count`, `quality_score`, `qc_status`, risk flags).
- `get_server_summary` — Input: `server_id`. Output: slim server profile, no full
  `tool_schemas` payload by default.
- `find_tools` — Inputs: `query`, `limit`. Output: matching tool
  names/descriptions with server context.
- `recommend_servers_for_task` — Inputs: `task`, `limit`, optional
  `prefer_no_env_vars`. Output: deterministic heuristic recommendation over
  current D1 fields; no LLM dependency in v1.

**Paid tool:**

- `get_install_risk_report` — Price: test mode $0.01, production configurable via
  `MCP_RISK_REPORT_PRICE_USD`. Input: `server_id`. Output: richer QC-derived
  report (install timing, schema size, env-var requirement, hang/proxy/destructive
  flags, recent QC status, recommended install posture).

## 5. Input Validation

All tool inputs are validated with `zod` schemas at the MCP boundary:
`query`/`task` are non-empty strings capped at 200 chars; `limit` is an integer
coerced into `[1, 20]` (default 10); filter flags are booleans; `server_id` is a
string matching the existing ID charset. Validation failure returns the §11
structured MCP error, never a raw exception.

## 6. Payment Design

x402 config via environment variables (secrets for sensitive values):

- `X402_ENABLED`: `false` by default.
- `X402_NETWORK`: `base-sepolia` (test) / `base` (production).
- `X402_RECIPIENT`: recipient wallet address. **Owner: the toolidx operator
  (Gregory); set as a Wrangler secret, never committed.** Empty/absent ⇒ treated
  as `X402_ENABLED=false` regardless of the flag (fail-closed-to-free).
- `X402_FACILITATOR_URL`: facilitator URL. **Owner: operator;** for `base-sepolia`
  use the public Coinbase/x402 test facilitator (confirmed reachable during Phase
  3 setup, else a documented mock). No private keys live in the Worker — x402
  settlement is facilitator-mediated; the Worker only declares price + recipient
  and verifies the payment proof.
- `MCP_RISK_REPORT_PRICE_USD`: default `0.01`.

**Registration mode:**
- `X402_ENABLED=false` (local/test default) ⇒ `get_install_risk_report` registered
  as a **free** tool.
- `X402_ENABLED=true` ⇒ registered via `paidTool` with the configured network.

**Verification timing:** the x402 payment challenge/verification happens **before**
the tool handler body executes — an unpaid call returns a `402` payment-required
challenge and the D1 risk query never runs. Only a verified payment proof reaches
the handler. **Failure shape:** missing payment ⇒ standard x402 `402` challenge;
invalid/insufficient payment ⇒ MCP error with `code: "payment_invalid"` and a
human-readable message, no risk data leaked.

**Production-enable checklist (G5 — all required before `X402_NETWORK=base`):**
1. Recipient wallet address approved and set as secret.
2. Production facilitator URL approved and reachable.
3. `MCP_RISK_REPORT_PRICE_USD` set to the approved price.
4. Written payment-support/refund policy published in docs.
5. `base-sepolia` payment tests (§11) green.
6. Explicit operator sign-off recorded.

Guardrails: do not require accounts/API keys for free tools; do not gate the whole
server; do not expose bulk export or raw QC history on the free surface. Until the
checklist is met, `X402_NETWORK` stays `base-sepolia` and/or `X402_ENABLED=false`.

## 6.5 Monetization Strategy (G6)

**Stated goal.** toolidx.dev has accumulated real, defensible work — verified MCP
server listings, QC test results, install-risk signals, quality scoring. The
explicit goal of this and subsequent releases is to **monetize that work into
recurring revenue** while keeping basic directory discovery free (free tier drives
agent adoption; paid tier sells the QC/risk intelligence that is expensive to
produce). The per-call paid `get_install_risk_report` tool (§6) is the **first,
deliberately small** monetization step — chosen because it is low-risk, validates
willingness-to-pay, and reuses existing QC data.

**Candidate revenue lines (catalog, not all committed in v1).** Listed so the
operator can pick deliberately; each carries a rough effort/risk note. The
cross-review explicitly invites reviewers to critique these and **propose
additional creative monetization avenues**:

1. **Per-call premium MCP tools (in progress).** `get_install_risk_report` now;
   later e.g. `compare_servers`, `get_full_tool_schemas`, `audit_my_server_list`.
   Low effort, pay-per-use, agent-native via x402.
2. **Subscription / API key tier.** Flat monthly for higher rate limits + all
   premium tools, for teams wiring toolidx into their agents. Medium effort
   (billing + key management).
3. **Verified-listing / sponsored placement (supply side).** Paid expedited QC,
   "verified" badge, or clearly-labeled sponsored ranking for server authors —
   must stay honest (disclosed, never distorts risk flags). Medium effort, brand
   risk if not transparent.
4. **Bulk / dataset licensing.** Sell the curated QC dataset (or a snapshot feed)
   to enterprises building their own internal MCP catalogs. Low-to-medium effort;
   deliberately kept **off** the free public surface (§8) so it retains value.
5. **Hosted "MCP risk gate" for CI/CD.** A webhook/API that fails a build if a
   referenced MCP server is unverified/destructive — sold to platform teams.
   Higher effort (new surface), high differentiation.
6. **White-label / embed.** License the discovery+risk widget to dev-tool vendors
   and IDEs. Higher effort, partnership-driven.

**Guardrails on monetization:** never gate or degrade the free discovery tier
below its current usefulness; never let paid placement alter or hide risk/QC
signals; revenue features ship behind flags and follow the §6 production-enable
discipline. v1 commits only to line 1; lines 2–6 are parked for explicit later
decision.

## 7. Security & Transport

**Transport.** Primary transport is **Streamable HTTP** at `/mcp` via
`ToolidxMcp.serve('/mcp')`. SSE at `/sse` via `serveSSE('/sse')` is **optional and
off unless explicitly enabled** (legacy-client compatibility only). The MCP server
exposes no stdio transport itself; desktop clients that speak only stdio (e.g.
Claude Desktop) bridge to the remote HTTP endpoint via `mcp-remote` (§10).

**Origin / DNS-rebinding / CORS.** Implemented at the `/mcp` (+ `/sse`) edge before
the agent runs:
- Validate `Origin` against an allowlist env var (`MCP_ALLOWED_ORIGINS`). In
  development, additionally allow known MCP Inspector / `localhost` / `127.0.0.1`
  origins.
- **Missing `Origin`** (non-browser agent clients) ⇒ allowed (agents legitimately
  send no Origin); **present but not allowlisted** ⇒ rejected with `403`.
- Validate the `Host` header against the expected `toolidx.dev` host to blunt
  DNS-rebinding.
- CORS: for allowlisted browser origins, emit `Access-Control-Allow-Origin` echo +
  `Access-Control-Allow-Methods`/`-Headers` and handle `OPTIONS` preflight, so
  browser-based Inspectors/agents can connect. Non-browser clients are unaffected.

**Logging.** Structured log per call: tool name, success/failure, latency, result
count, paid/free mode. Never log payment credentials/proofs or full `tool_schemas`
bodies.

## 8. Data Access (D1)

- Query D1 directly from MCP handlers using the **existing house pattern**:
  `c.env.DB.prepare(...).bind(?)` parameter binding for every user-supplied value
  (no string interpolation into SQL) — matching the current `/v1/*` handlers.
- **Same safety filters as REST:** public discovery defaults to `status = 'active'`
  and, for verified surfaces, `qc_status = 'passed'`. `get_server_summary` /
  `get_install_risk_report` look up by `id` with `status = 'active'` (mirrors
  existing `src/index.ts` server-by-id queries).
- **Bounded results:** every list query carries a SQL `LIMIT` bound from the
  validated `limit` (max 20); search uses `LIKE`-based matching over indexed
  columns consistent with existing search, with `LIMIT` enforced in SQL (not just
  post-trim) so no unbounded table scan returns to the client.
- Unknown `server_id` ⇒ the §11 structured "not found" MCP error.

## 9. Discovery

- `/.well-known/mcp.json` is updated **additively only**: add a `transport`
  pointer object describing the live `/mcp` Streamable HTTP endpoint. No existing
  field is removed or renamed, so the "behavior unchanged" guarantee holds for all
  existing consumers (additive superset).
- The route stays on the **schema-clean allowlist** in `src/index.ts` (the set
  that suppresses `last_updated` injection) so the augmented body remains
  schema-clean — consistent with the v5 SEO well-known handling.
- Only describe the `/mcp` transport in the well-known file if it is actually live
  (added in Phase 4, after Phase 1 proves the endpoint).

## 10. User-Facing Docs

- MCP endpoint URL (`https://toolidx.dev/mcp`).
- Free vs paid tool list and current payment-test status.
- `mcp-remote` client config example for desktop MCP clients:
  `npx mcp-remote https://toolidx.dev/mcp`.
- Payment-support/refund policy (added when the §6 checklist is worked).

## 11. Test Plan

**Unit — each handler's D1 behavior (representative rows):**
- verified `active`/`passed` server **is** returned;
- `failed`/`pending`/`rejected`/non-`active` rows **excluded** from search and
  by-id lookups;
- `requires_env_vars` / `hangs_on_start` / `is_proxy` filters select correctly;
- `limit` cap enforced in SQL (request `limit=50` ⇒ at most 20 rows; SQL contains
  `LIMIT`);
- unknown `server_id` ⇒ structured error (see error shape below).

**Concrete response shapes (replaces ambiguous criteria):**
- Success: MCP tool result with `content[0].type === "text"` (concise summary)
  plus `structuredContent` JSON matching the §4 field list; result array length
  ≤ requested `limit`.
- "Valid content" for a free tool = non-empty `content` array, `isError` falsy,
  and `structuredContent` parses against the tool's zod output schema.
- "Clear MCP error" (unknown id / validation failure) = MCP error response with
  `isError: true`, a stable `code` string (`not_found`, `invalid_input`,
  `payment_invalid`), and a one-line human message; no stack trace, no partial
  data.
- "Fails cleanly" (payment) = `402` challenge (unpaid) or `payment_invalid` error
  (bad proof); in both cases zero rows of risk data returned.

**Integration — `/mcp` via MCP Inspector or SDK client:**
- `initialize` succeeds and returns server info;
- tool list includes **exactly** the four free tools + `get_install_risk_report`
  (5 total), no extras;
- each free tool returns the success shape above;
- `get_install_risk_report` is free (returns a report, no challenge) when
  `X402_ENABLED=false`.

**Payment test (`X402_ENABLED=true`, `base-sepolia`):**
- unpaid premium call ⇒ `402` challenge;
- paid retry with valid proof ⇒ risk report;
- invalid/insufficient proof ⇒ `payment_invalid` error, no data;
- absent `X402_RECIPIENT` ⇒ tool falls back to free (fail-closed-to-free).

**Regression:**
- `/v1/status`, `/v1/servers`, `/openapi.json`, `/llms.txt`,
  `/.well-known/mcp.json` respond as before (mcp.json now an additive superset);
- `/.well-known/mcp.json` body stays schema-clean (no `last_updated` injected);
- `npx tsc --noEmit` clean;
- `npx wrangler deploy --dry-run` clean.

**Manual acceptance:**
- connect from MCP Inspector;
- connect from a desktop MCP client through `mcp-remote`;
- ask an agent: "Find an installable MCP server for filesystem/search and explain
  the risk." Confirm it uses toolidx tools with no REST/API knowledge.

## 12. Risks & Non-Goals

- **Cold start / script size:** the `agents` SDK increases Worker bundle size and
  may slightly raise first-request cold-start latency in a region. Acceptable for
  v1; measure during Phase 1.
- **Durable Object cost:** the McpAgent DO adds a small new Cloudflare cost line.
  Expected minimal at launch volume.
- **x402 test facilitator:** Phase 3 confirms a reachable `base-sepolia`
  facilitator at setup; if none, a documented mock is used and noted in docs.
- **Non-goals (v1):** no third-party MCP servers are installed or executed by this
  server — it only recommends and reports on toolidx data.

## 13. Assumptions

- First release optimizes for agent adoption as the path to revenue (G6): free
  tier wins adoption, paid QC/risk intelligence monetizes it; v1 ships the first
  paid tool, not the full monetization catalog (§6.5).
- Public REST remains available and unchanged.
- Premium value is QC/risk intelligence, not basic directory lookup.
- Production x402 stays disabled until the §6 checklist is satisfied and signed off.
