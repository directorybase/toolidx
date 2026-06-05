---
title: Public toolidx MCP Server With Payment Options
version: v3
supersedes: outputs/2026-06-05-toolidx-mcp-server-plan-v2.md
---

# Public toolidx MCP Server With Payment Options (v3)

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

### Pass 2 — v2 → v3 (reviewers: gemini ACCEPT, codex accept-with-changes → mixed, continue)

Gemini ACCEPTed v2 (all 5 of its must-fixes resolved); its two new items were
`[mechanical]` advisory under the accept (DO mount syntax, migration-tag naming) —
folded into N1 below. Codex resolved 5/6 prior items and left one hard blocker (DO
migration rollback) plus new gaps:

| # | Must-fix | Raised by | Class | Addressed in |
|---|----------|-----------|-------|--------------|
| N1 | DO rollback must be append-only (never delete a deployed migration); migration tag = next-unused, not literal `v1`; clarify SDK mount/invocation | codex+gemini | mechanical | §2 Phase 1, §3 |
| N2 | `X402_ENABLED=true` with absent recipient/facilitator must fail loud at startup, not silently register the premium tool as free (production exposure) | codex | design | §6 |
| N3 | Host allowlist must be env-configurable for preview/staging/custom domains, not hardcoded to `toolidx.dev` | codex | design | §7 |
| N4 | LIMIT enforcement must be asserted by row-count against a large fixture, not "SQL contains LIMIT" | codex | design | §11 |

Monetization ideas from both reviewers (recorded, non-blocking) appended to §6.5.

### Post-acceptance amendment (user-directed, NOT reviewer-vetted)

After the dual ACCEPT, the operator directed expanding §6.5 line 7 (QC-on-demand /
"verify my server") into a developed **badge play** — the recommended first revenue
experiment: cheap/free initial verification to seed a "Verified by toolidx" README
badge (distribution), with recurring revenue from re-verification + drift alerts
(folds into lines 10/15), plus an honesty guardrail (pay to be tested, never to
pass). This edit was made **outside the review loop**. It changes only §6.5
(monetization backlog); the reviewed, accepted implementation scope (§2–§11) is
unchanged.

**Quick single-shot review of the badge play (both reviewers, not the loop):**
gemini and codex both returned **sound-with-changes**, converging on five risks —
abuse of free verification (sandbox exhaustion / evasion oracle), badge staleness
(zombie badge), version mismatch (tested URL vs published `install_command`), badge
authority/ownership, and endorsement/liability wording. Their P1 fixes are folded
into the §6.5 line-7 "Pre-launch guardrails" block. One-shot critique, not an
iterate-to-accept loop.

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

- **Phase 1 — Foundation (reversible: pre-deploy revert config; post-deploy disable route, migrations stay append-only — see rollback note).**
  Add deps (`agents`, `@modelcontextprotocol/sdk`; reuse `zod`). Add the
  `ToolidxMcp` Durable Object binding + migration to `wrangler.jsonc`
  (`new_sqlite_classes`, see §3). Add the named `ToolidxMcp` export and wire the
  `/mcp` route into the Hono default export. Run `npx wrangler types`. Acceptance:
  `wrangler deploy --dry-run` succeeds; `/mcp` `initialize` returns a valid MCP
  server-info response; no existing route changes behavior.
  *Rollback (before first deploy):* remove the route + export + binding +
  migration from the unshipped config. *Rollback (after deploy):* Cloudflare DO
  migration history is **append-only** — do **not** delete an already-deployed
  migration entry. Roll back by removing the `/mcp` route and ceasing to use the
  DO (and, if the class must be retired, add a *forward* `deleted_classes`
  migration with a new tag), leaving prior migration history intact. Because the
  DO holds no durable business state in v1 (stateless query handlers), disabling
  the route fully neutralizes the feature.

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
  - `migrations`: add a **new entry with the next unused tag** (the repo already
    has D1 migrations `0001`–`0015`, and `wrangler.jsonc` may carry its own DO
    `migrations` array — pick a fresh, non-colliding tag such as `mcp-v1`, not a
    literal `"v1"`): `{ "tag": "mcp-v1", "new_sqlite_classes": ["ToolidxMcp"] }`
    (McpAgent requires the SQLite-backed DO storage class). DO migration entries
    are append-only once deployed (see §2 rollback).
  - Run `npx wrangler types` after the config change so `MCP_OBJECT` appears in
    `worker-configuration.d.ts`.

- **Route wiring (Hono coexistence).** The Worker's `export default` currently
  delegates `fetch` to `app.fetch` (Hono) and adds `scheduled`. Wire `/mcp` (and
  `/sse` if enabled, §7) using the Agents SDK's documented mount helper
  (`ToolidxMcp.serve('/mcp')` / `ToolidxMcp.serveSSE('/sse')`, which return a
  fetch handler that internally routes to the `MCP_OBJECT` DO instance) **before**
  delegating the remainder to `app.fetch`, so Hono continues to own all existing
  routes untouched. Follow the SDK's current mount/invocation signature at
  implementation time (whether the static `.serve()` helper or an explicit
  `env.MCP_OBJECT` fetch handoff) — the contract here is "DO-backed handler for
  `/mcp`, everything else to Hono", not a specific call form. The `scheduled`
  handler is unchanged.

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
  (Gregory); set as a Wrangler secret, never committed.** Behavior is split by the
  enable flag (see config-validation guardrail below): with `X402_ENABLED=false`,
  an absent recipient is fine (the tool is free anyway); with `X402_ENABLED=true`,
  an absent recipient is a **hard startup error**, never a silent free fallback.
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

**Config-validation guardrail (fail-loud, not fail-to-free).** At startup, if
`X402_ENABLED=true` but `X402_RECIPIENT` or `X402_FACILITATOR_URL` is absent/empty,
the server **fails loudly** — it throws a clear config error and does **not**
register the premium tool as free. This prevents the production footgun of
silently giving away the paid report when payments were meant to be on. The
fail-to-free path applies **only** when `X402_ENABLED=false` (the explicit test/dev
default).

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

**Reviewer-proposed candidates (recorded from cross-review, non-blocking).** These
extend the catalog and are parked alongside lines 2–6 for deliberate selection:

7. **QC-on-demand / "verify my server" + the badge play (recommended first
   revenue experiment).** Paid immediate sandbox test of any GitHub/NPM MCP URL,
   reusing the existing QC pipeline, returning the same install-risk signals the
   directory already computes (gemini). Two reasons this is the first thing to try:
   - **It earns *and* distributes.** A passing test mints a **"Verified by
     toolidx"** badge (SVG + deep link back to the server's toolidx profile) that
     authors embed in their README. Every badge is free, compounding top-of-funnel
     that points back at toolidx — the directory's value grows as the badge spreads.
   - **Sell the watching, not the one-time check.** The badge is the highest-
     leverage asset here, so consider making the *initial* verification cheap or
     free to seed badge distribution, and charging for the **recurring** layer:
     re-verification on every release, drift/risk-change alerts when a verified
     server later adds destructive tools / new env vars / starts hanging, and the
     "still verified as of <date>" freshness guarantee behind the badge. This folds
     directly into the risk-monitor subscription / retest lines (10, 15) and turns
     a one-shot fee into recurring revenue.
   - **Honesty guardrail:** the badge reflects QC outcome only and is never for
     sale — a server cannot pay to pass, only pay to *be tested* (and to be
     re-tested / watched). A failing test does not mint a badge.
   - **Pre-launch guardrails (from quick cross-review, both reviewers
     "sound-with-changes"):**
     - **Ownership proof before minting a public badge** — GitHub repo-admin
       check / npm package ownership / DNS or `.toolidx` file challenge. Anyone may
       pay to *test or watch* a server; only a proven owner gets the official
       "Verified" badge SVG.
     - **Bind every badge to immutable evidence** — package name+version, commit
       SHA, tarball hash, test timestamp, QC policy version, and the exact
       `install_command` tested. Prevents the version-mismatch shell game (verify a
       clean branch, ship a malicious one).
     - **Dynamic badge, never a static SVG** — serve from a live endpoint
       (`toolidx.dev/v1/badge/<id>.svg`) with explicit status states
       (`verified` / `stale` / `failed` / `revoked` / `unknown`) and a freshness
       date; status flips automatically when QC changes. Kills the "zombie badge."
       The badge deep-links to a canonical public report of what was/wasn't tested.
     - **Anti-abuse before any free tier opens** — per-account/repo/IP quotas,
       queueing, sandbox time/CPU/network limits, denylists, and a manual-review
       queue for suspicious submissions, so free verification can't be used as a
       DDoS vector or an evasion-testing oracle on toolidx infra.
     - **Precise, defensible wording** — "QC passed by toolidx (as of <date>)",
       not "certified/safe". Register the mark and publish Terms of Badge Use that
       let toolidx compel removal of a stale/cached badge. Avoids endorsement/
       liability creep.
   - **Scope note:** this is a directory/QC-surface feature, **not** part of the v1
     MCP server build (§2–§11); it is sequenced as the first monetization
     experiment once the free MCP tools are driving adoption.
8. **MCP firewall / runtime policy proxy.** Paid proxy that checks an agent's live
   tool calls against toolidx risk metadata and blocks destructive calls in
   real-time — toolidx as an active security component, not a passive directory
   (gemini); a low-latency "should this agent install/use this server?" decision
   endpoint for agent runtimes (codex).
9. **LLM-assisted premium search.** Paid "pick-of-the-bunch" search that returns
   the single best tool for a prompt using QC success rates + quality scores; LLM
   cost passed through with margin (gemini).
10. **Risk-monitor subscriptions / risk feed.** Alert teams when a watched server
    changes QC status, adds destructive tools, requires new env vars, or starts
    hanging; daily signed JSON feed of newly-destructive/failed servers for
    enterprise blacklisting (gemini + codex).
11. **MCP allowlist feed.** Paid, signed JSON feed enterprises use to enforce
    approved servers in internal agents (codex).
12. **Vendor security profiles.** Paid public author profile pages with historical
    QC, provenance, changelog, trust badges (codex).
13. **Private catalog hosting.** Team-specific MCP directory with internal notes,
    approvals, policy labels (codex).
14. **Procurement audit packets.** Downloadable security-review artifacts (install
    posture + historical QC evidence) for enterprise procurement (codex).
15. **Continuous QC retesting.** Paid faster retest cadence for authors/teams
    monitoring critical servers (codex).
16. **Marketplace revenue share.** Referral/hosting revenue for installs or served
    MCP services, clearly labeled (codex).

Note (codex): "recurring revenue" in G6 is broader than the v1 per-call x402 tool —
per-call validates willingness-to-pay but is not inherently recurring; the
subscription/feed lines (2, 10, 11, 15) are the recurring-revenue candidates. Treat
§6.5 as a monetization backlog, not a v1 acceptance criterion.

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
- Validate the `Host` header against an **env-configured allowlist**
  (`MCP_ALLOWED_HOSTS`, default `toolidx.dev`) to blunt DNS-rebinding. Preview,
  staging, and custom domains add their hosts to this var so tests and Inspector
  connections pass off-production; an empty/unset value falls back to the canonical
  production host only.
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
- `limit` cap enforced: against a fixture of **>20 matching active rows**, a
  request of `limit=50` returns **at most 20 rows** (assert on returned row count,
  not on SQL string inspection), proving the cap is enforced in the query path;
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
- `X402_ENABLED=true` with absent `X402_RECIPIENT`/`X402_FACILITATOR_URL` ⇒ server
  fails loudly at startup with a config error (the §6 guardrail), **not** a silent
  free fallback.

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
