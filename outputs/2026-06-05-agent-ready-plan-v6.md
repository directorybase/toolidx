---
title: toolidx.dev — Agent-Readiness Plan (isitagentready.com)
version: v6
supersedes: outputs/2026-06-05-agent-ready-plan-v5.md
date: 2026-06-05
note: v6 is an audit-only close-out. The reviewer-ACCEPTED artifact is v5; v6 differs only in this audit block. Accepted by BOTH reviewers — Gemini (at v2) and Codex (at v5).
---

# toolidx.dev — Agent-Readiness Plan (isitagentready.com) — v5 (ACCEPTED by Gemini + Codex)

**Branch:** seo-maintenance-v5
**Worker entry:** `src/index.ts` (Hono + Chanfana)
**Constraint:** Additive only — **do not change existing `/v1/*` API logic, and do not change the behavior of any existing route** (including the existing `/.well-known/mcp.json`). New routes, new middleware that only *adds* headers, new static files, and edits to the `robots.txt`/`llms.txt` string content. The one deliberate exception (see §0a) is a narrow *exclusion* guard added to the existing `last_updated` JSON middleware, scoped to an explicit allow-list of **new** routes only — it does not alter behavior for any existing route.

---

## 0. Crosscheck responses (audit)

### Pass 1 — v1 → v2 (reviewer: gemini, verdict: accept-with-changes)

| # | Must-fix (gemini) | Class | Resolved in v2 §  |
|---|---|---|---|
| 1 | Native `Response` headers immutable after `next()`; `headers.set()` throws. Re-wrap. | design | §1 — re-wrap `c.res = new Response(c.res.body, c.res)`. |
| 2 | MCP `serverInfo.name` should be reverse-DNS, not bare `toolidx`. | design | §4 — `dev.toolidx/directory`. |
| 3 | Linkset Content-Type needs RFC 9727 `profile` param. | design | §3. |
| 4 | Agent Skills digest must be algorithm-prefixed. | design | §6. |
| 5 | robots.txt: per-bot blocks hide `Content-Signal` under `*`. Drop them. | design | §2. |

### Pass 2 — v2 ACCEPTED (reviewer: gemini, verdict: accept)
All 5 resolved, no regressions. Gemini trajectory: **5 → 0** in 2 passes.

### Pass 3 — v2 → v4 (reviewer: codex, independent second reviewer, verdict: accept-with-changes)

Codex caught issues Gemini missed — chiefly the existing JSON middleware polluting new well-known bodies.

| # | Must-fix (codex) | Class | Resolved in v4 §  |
|---|---|---|---|
| 1 | The existing `last_updated` middleware injects a top-level field into **every** `application/json` response → pollutes the MCP card (§4) and Agent Skills index (§6); strict validators reject the extra key. (API catalog escapes: `application/linkset+json` ≠ substring `application/json`.) | design | §0a — add a narrow `/.well-known/` exclusion guard to the existing middleware; new JSON well-known routes emit clean bodies. |
| 2 | SEP-1649 server card **requires** `$schema, version, protocolVersion, serverInfo, transport, capabilities`. toolidx is a *directory*, not a live MCP server with a transport → emitting a card risks an invalid/misleading file. | design | §4 — **default to SKIP + document**; only emit if an honest, schema-valid card is possible for a registry. |
| 3 | `rel="mcp-server"` is not an IANA-registered relation; RFC 8288 requires extension rels to be **absolute URIs**, not bare tokens. | design | §1 — dropped the `mcp-server` token rel; only registered rels remain. |
| 4 | Agent Skills v0.2.0 entry uses `digest: "sha256:<hex>"` (field name `digest`), not `{ sha256: ... }`. | design | §6 — field corrected. |
| 5 | Verification missing: schema validation for linkset/server-card/agent-skills + a `last_updated`-pollution check + `Vary: Accept` regression. | design | Verification §. |

Affirmed by both reviewers: WebMCP deferral; honesty-based OAuth/Auth/Commerce exclusions; immutable-Response re-wrap (§1); `_index._agents.toolidx.dev` DNS-AID entry point; `llms.txt` correctness cleanup.

### Pass 4 — v4 → v5 (reviewer: codex, resumed, verdict: accept-with-changes)

Codex confirmed #2–#5 resolved; flagged the §0a guard as over-broad.

| # | Must-fix (codex) | Class | Resolved in v5 §  |
|---|---|---|---|
| 1 | §0a guard `path.startsWith("/.well-known/")` also suppresses `last_updated` on the **existing** `/.well-known/mcp.json` route (which currently emits it) → an unintended behavior change to an existing route, contradicting the constraint. | design | §0a — guard scoped to an explicit allow-list of **new** routes only; `/.well-known/mcp.json` left byte-for-byte unchanged. |
| 2 | Verification lacks an assertion pinning `/.well-known/mcp.json`'s behavior after the guard. | mechanical | Verification §1 — added: existing `/.well-known/mcp.json` **still** contains `last_updated`. |

### Pass 5 — v5 ACCEPTED (reviewer: codex, resumed, verdict: accept)

> "Both gaps from Pass 4 are fully resolved in v5. No regressions. No new gaps. The plan is accepted."

**Loop complete — accepted by both reviewers.** Trajectories: Gemini **5 → 0** (2 passes, accepted at v2); Codex **5 → 2 → 0** (3 passes, accepted at v5). The accepted artifact is **v5** (`outputs/2026-06-05-agent-ready-plan-v5.md`); this v6 file is the audit-only lineage terminus.

---

## 0a. The `last_updated` middleware interaction (cross-cutting — read before §3/§4/§6)

`src/index.ts` (~lines 44–69) has a global middleware that, after `next()`, rewrites **any** response whose Content-Type includes the substring `application/json`, injecting a top-level `last_updated`. Consequences for new routes:

- **API catalog (§3)** — safe. `application/linkset+json` does **not** contain `application/json` as a substring, so the guard `contentType.includes("application/json")` is false. No pollution.
- **MCP server card (§4) & Agent Skills index (§6)** — **NOT safe** if emitted via `c.json()` (Content-Type `application/json`). They would gain a stray `last_updated` key that strict SEP-1649 / Agent-Skills validators (root `additionalProperties: false`) reject.
- **Existing `/.well-known/mcp.json`** — currently emits `last_updated` (confirmed live: `"last_updated":"…"`). Its behavior **must not change.** A broad `path.startsWith("/.well-known/")` guard would strip that field — an unintended change to an existing route (codex Pass-4 #1). The guard must therefore be an explicit allow-list of **new** routes, not a prefix match.

**Chosen fix (additive, honors the constraint):** add a single early-return exclusion to the *top* of the existing middleware, scoped to the explicit set of new clean-JSON routes:

```ts
// New routes whose JSON bodies must stay schema-clean (no last_updated injection).
// EXPLICIT allow-list — NOT a /.well-known/ prefix match — so the pre-existing
// /.well-known/mcp.json route keeps its current behavior (still gets last_updated).
const CLEAN_JSON_PATHS = new Set([
  "/.well-known/agent-skills/index.json",
  "/.well-known/mcp/server-card.json", // only if §4 ships; harmless if it doesn't
]);

app.use("*", async (c, next) => {
  await next();
  if (CLEAN_JSON_PATHS.has(new URL(c.req.url).pathname)) return; // new routes only
  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;
  // ...unchanged existing logic...
});
```

`/.well-known/mcp.json` is **not** in the set, so it is byte-for-byte unchanged. The guard touches the behavior of **no existing route**. (`/.well-known/api-catalog` need not be listed — it already escapes via its `application/linkset+json` Content-Type — but adding it would be harmless.) **Flagged for operator sign-off** as the single deliberate edit to that middleware.

---

## Context

`isitagentready.com` (a Cloudflare scanner) scored `toolidx.dev` **21 / Level 1 (Basic Web Presence)** on 2026-06-04. The site already ships robots.txt, sitemap.xml, llms.txt, `/.well-known/mcp.json`, `/openapi.json`, OG tags, and JSON-LD — but fails several emerging agent-discovery checks. This plan closes every failure that can be fixed *honestly* from the Worker, and documents the rest.

**Actual scan results (ground truth, not the generic rubric):**

| Category | Score | Failing checks |
|---|---|---|
| Discoverability | 2/4 | Link headers ❌, DNS-AID ❌ (DNS-level) |
| Content | 0/1 | Markdown negotiation ❌ |
| Bot Access Control | 1/2 | Content Signals ❌ (AI-bot wildcard already passes) |
| API/Auth/MCP/Skill | 0/7 | API Catalog ❌, MCP Server Card ❌, Agent Skills ❌, WebMCP ❌, OAuth×3 ❌, Auth.md ❌ |
| Commerce | not scored | informational only |

**Decision:** Implement all *honest, worker-addressable* fixes. Explicitly **exclude** OAuth/OIDC, OAuth Protected Resource, Auth.md (the `/v1/*` API is public — they'd advertise auth that doesn't exist) and Commerce (none; not scored). DNS-AID is a separate dashboard task. The MCP Server Card is **conditionally excluded** pending SEP-1649 verification (likely no honest transport — see §4).

**Realistic target after this plan:** Discoverability 3/4, Content 1/1, Bot Access 2/2, API/MCP **2/7** (API Catalog + Agent Skills; MCP card likely skipped) → solid Level 2. (+1 each later if DNS-AID is added and/or a valid registry-style MCP card proves possible.)

---

## Scope summary

| # | Fix | Surface | Moves | Confidence |
|---|---|---|---|---|
| 1 | `Link:` response headers | new middleware | Discoverability +1 | high |
| 2 | Content Signals (robots.txt) | edit robots.txt string | Bot Access +1 | high |
| 3 | `/.well-known/api-catalog` | new route | API/MCP +1 | high |
| 4 | MCP Server Card | new route | API/MCP +1 | **low — likely skip (no transport)** |
| 5 | Markdown negotiation | new middleware + renderers | Content +1 | high |
| 6 | Agent Skills index | new route | API/MCP +1 | medium (emerging) |
| 7 | WebMCP client tool | edit HTML renderers | API/MCP +1 | low (deferred, phase 2) |
| 0a | `last_updated` middleware allow-list skip-guard (new routes only) | edit existing middleware (exclusion only; existing routes untouched) | enables §4/§6 | high |
| D | DNS-AID records | Cloudflare DNS dashboard (NOT worker) | Discoverability +1 | document only |
| X | OAuth/Auth/Commerce stubs | — | — | **excluded (dishonest)** |
| C | Stale `llms.txt` score fields | edit llms.txt renderer | correctness | flagged optional |

---

## Implementation

### 1. Link response headers (RFC 8288)

**Why:** Scanner found no `Link` header on `/`.

**How (additive middleware):** Register *before* routes. Native `Response` headers are immutable after `next()` (the existing `last_updated` middleware rebuilds rather than mutating for the same reason), so re-wrap before setting. Use **only IANA-registered relation types** — `mcp-server` is not registered and a bare extension token is invalid under RFC 8288 (extension rels must be absolute URIs). Dropped it; the MCP card (if shipped) is discoverable at its well-known path and via the API catalog.

```ts
// after app.onError, before the last_updated middleware
app.use("*", async (c, next) => {
  await next();
  const ct = c.res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html") && !ct.includes("text/plain")) return;
  if (c.res.headers.has("link")) return;
  c.res = new Response(c.res.body, c.res); // headers now mutable
  c.res.headers.set("Link", [
    '</.well-known/api-catalog>; rel="api-catalog"',      // registered (RFC 9727)
    '</openapi.json>; rel="service-desc"; type="application/json"', // registered
    '</docs>; rel="service-doc"',                          // registered
    '</llms.txt>; rel="alternate"; type="text/plain"',     // registered
    '</sitemap.xml>; rel="sitemap"',                        // registered
  ].join(", "));
});
```

**Files:** `src/index.ts` (new middleware block).

### 2. Content Signals (robots.txt)

**Why:** Bot Access 1/2 — no `Content-Signal`. The AI-bot-rules check **already passes** via the existing `User-agent: *` wildcard, so no per-bot blocks (which would *hide* the signal from those bots — gemini #5).

Default policy = permissive (the directory *wants* to be consumed). Confirm `ai-train` stance before ship.

```
# Content usage preferences — https://contentsignals.org
User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=yes
Allow: /
Disallow: /v1/

Sitemap: https://toolidx.dev/sitemap.xml
```

**Open item:** confirm exact `Content-Signal` grammar against contentsignals.org. Scanner guidance string: `Content-Signal: ai-train=no, search=yes, ai-input=no`.

**Files:** `src/index.ts` (`/robots.txt` route string).

### 3. API Catalog — `/.well-known/api-catalog` (RFC 9727)

**Why:** Scanner wants `application/linkset+json` with a `linkset` array. Not affected by the JSON middleware (§0a).

```ts
app.get("/.well-known/api-catalog", (c) =>
  c.body(JSON.stringify({
    linkset: [{
      anchor: "https://toolidx.dev/v1",
      "service-desc": [{ href: "https://toolidx.dev/openapi.json", type: "application/json" }],
      "service-doc":  [{ href: "https://toolidx.dev/docs", type: "text/html" }],
      status:         [{ href: "https://toolidx.dev/v1/status", type: "application/json" }],
    }],
  }), 200, {
    "Content-Type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    "Cache-Control": "public, max-age=3600",
  })
);
```

**Verify:** relation-array shape against **RFC 9727 Appendix A** before ship.

**Files:** `src/index.ts` (new route, before `fromHono`).

### 4. MCP Server Card — `/.well-known/mcp/server-card.json` (SEP-1649) — **conditional / likely skip**

**Problem:** The scanner fails our flat `/.well-known/mcp.json` and wants the SEP card. **But** SEP-1649 (PR `modelcontextprotocol/modelcontextprotocol#2127`) requires `$schema, version, protocolVersion, serverInfo, transport, capabilities`. **toolidx is a directory *of* MCP servers, not a live MCP server — it has no `transport`.** Emitting a card with a fake/empty transport is an invalid, misleading file (codex #2).

**Decision:**
1. At implementation time, read SEP-2127 and check whether a *registry/directory* may publish a transport-less card (some registry profiles exist).
2. **If a valid, honest card is possible** → emit it (via raw `Response`, not `c.json()`; §0a keeps it clean), `serverInfo.name = "dev.toolidx/directory"` (reverse-DNS, gemini #2), filling all required fields honestly.
3. **If `transport` is mandatory** → **skip this check and document it.** Do not ship an invalid card to game one scanner. Accept the lost point; the directory's MCP servers are already discoverable via `/v1` + the API catalog + per-server records.

**Default lean: skip unless step 2 proves a valid card exists.**

**Files:** `src/index.ts` (new route, *only if* step 2 succeeds).

### 5. Markdown content negotiation

**Why:** Content 0/1 — `Accept: text/markdown` on `/` returns `text/html`.

**How (additive middleware, short-circuits before HTML routes):** When `Accept: text/markdown` for `/`, `/server/:id`, `/category/:slug`, return markdown with `Content-Type: text/markdown; charset=utf-8` and `Vary: Accept`. Must **not** match `/v1/*`. Browsers (HTML default) unaffected.

- Homepage markdown: reuse `renderLlmsTxt()` (`src/pages/llmstxt.ts`) — already valid markdown — or a dedicated `renderHomeMarkdown()`.
- Server/category markdown: new lightweight renderers from the same DB rows. Minimum to pass the scanner is the **homepage**; full coverage is better agent UX.

Keep the middleware self-contained (own DB reads) so existing handlers are untouched.

**Files:** `src/index.ts` (new middleware), optional `src/pages/markdown.ts`.

### 6. Agent Skills index — `/.well-known/agent-skills/index.json` (RFC v0.2.0)

**Why:** API/MCP — emerging skills discovery. Must be honest: only list capabilities toolidx actually exposes (search, lookup, verification data). Emit via raw `Response` so §0a keeps it clean.

**Format (codex #4 + gemini #4):** root `$schema` + `skills[]`, each entry:
```
{ "name": "...", "type": "...", "description": "...", "url": "https://toolidx.dev/...",
  "digest": "sha256:<64-hex>" }   // field name is `digest`; value is algorithm-prefixed
```
The `digest` covers the referenced skill artifact's bytes — confirm what it digests per the Cloudflare `agent-skills-discovery-rfc` v0.2.0 before ship; do not emit a placeholder hash.

**Files:** `src/index.ts` (new route).

### 7. WebMCP (phase 2 — deferred)

Inject a `<script>` into HTML renderers registering one honest tool (`search_mcp_servers` → `/v1/servers?...`) via `navigator.modelContext.provideContext()`. **Only** item that edits existing HTML renderers; both reviewers concurred on deferral. Origin-trial-era, near-zero consumers.

**Files:** `src/pages/landing.ts` (+ optional others) — script block only.

### D. DNS-AID (document only — NOT worker code)

Cloudflare DNS dashboard for `toolidx.dev`:
- SVCB/HTTPS records at `_index._agents.toolidx.dev` (confirmed directory entry point; optional `_mcp._agents.toolidx.dev`) with `alpn` + endpoint params per the DNS-AID IETF draft (RFC 9460 SVCB).
- DNSSEC enabled on the zone.

Worth +1 Discoverability (→ 4/4). Apply manually.

### X. Excluded — and why

- **OAuth/OIDC, OAuth Protected Resource, Auth.md** — `/v1/*` is unauthenticated; these advertise nonexistent token flows and break agents.
- **Commerce (x402, MPP, UCP, ACP)** — not scored; no commerce.
- **Web Bot Auth** — signs *outbound* bot requests; irrelevant to a public read API.

### C. Flagged correctness item (separate from scoring)

`src/pages/llmstxt.ts` still advertises `quality_score`/`sanity_score`, removed in v11 ("drop score/verdict model end-to-end"). Agents reading `llms.txt` get fields that no longer exist. **Recommend** removing/replacing those bullets with the current `coverage` model. Confirm against the live `/v1/servers/:id` shape first. Both reviewers: include it.

---

## Verification

1. **Local:** `npx wrangler dev`, then:
   - `curl -I http://localhost:8787/` → `Link:` header present, contains `api-catalog`; **no** unregistered `mcp-server` rel.
   - `curl -H "Accept: text/markdown" -I http://localhost:8787/` → `Content-Type: text/markdown` + `Vary: Accept`.
   - `curl -i http://localhost:8787/.well-known/api-catalog` → valid JSON, `Content-Type: application/linkset+json; profile=...`; **assert no `last_updated` key**.
   - `curl http://localhost:8787/.well-known/agent-skills/index.json` → `$schema` + `skills[]` with `digest: "sha256:..."`; **assert no `last_updated` key** (validates the §0a guard).
   - If §4 shipped: `curl http://localhost:8787/.well-known/mcp/server-card.json` → all SEP-required fields present, no `last_updated`.
   - `curl http://localhost:8787/robots.txt` → contains `Content-Signal:`, single `User-agent: *` group.
   - **Existing-route pin (codex Pass-4 #2):** `curl http://localhost:8787/.well-known/mcp.json` → **still contains `last_updated`** (the §0a allow-list must NOT cover this pre-existing route — proves no behavior change).
   - **Regression:** `curl http://localhost:8787/` (no Accept) → `text/html` + `Link`; `curl http://localhost:8787/v1/status` → unchanged JSON **with** `last_updated` and **no** `Link` header (proves both middlewares still scope correctly).
2. **Schema validation:** validate linkset (RFC 9727), agent-skills (v0.2.0), and — if shipped — the SEP-1649 card against their published schemas, not just "200 + parses."
3. **Tests:** run `tests/` for `/v1/*` regression. Add route tests per new well-known path + a `last_updated`-pollution test (assert excluded for the new allow-listed `/.well-known/*` routes, **still present** for `/v1/*` and for the existing `/.well-known/mcp.json`) + a middleware test that the `Link` re-wrap doesn't throw on a constructed `Response`.
4. **Deploy + re-scan:** `wrangler deploy`, re-run `isitagentready.com/toolidx.dev` (browser, JS-rendered); confirm category scores rose. Target ≥ Level 2.

## Risks / open items to resolve during implementation
- §0a middleware exclusion-guard — get operator sign-off (single deliberate touch to existing middleware; existing-route behavior unchanged).
- Exact `Content-Signal` grammar (contentsignals.org) — §2.
- RFC 9727 linkset relation-array shape (Appendix A) — §3.
- SEP-1649: whether a directory may publish a transport-less card — §4. **Default skip if transport is mandatory.**
- Agent Skills `digest` semantics (what bytes it covers) — §6.
