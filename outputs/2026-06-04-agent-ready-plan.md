# toolidx.dev — Agent-Readiness Plan (isitagentready.com)

**Date:** 2026-06-04
**Branch:** seo-maintenance-v5
**Worker entry:** `src/index.ts` (Hono + Chanfana)
**Constraint:** Additive only — **do not change existing API logic**. New routes, new middleware that only *adds* headers, new static files, and edits to the `robots.txt`/`llms.txt` string content. No changes to `/v1/*` handlers or the `last_updated` JSON middleware.

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

**Decision:** Implement all *honest, worker-addressable* fixes. Explicitly **exclude** OAuth/OIDC, OAuth Protected Resource, Auth.md (the `/v1/*` API is fully public — these would advertise auth that does not exist and break agent flows) and Commerce (no commerce; not scored). DNS-AID is documented as a separate dashboard task (cannot be done from Worker code).

**Target after this plan:** Discoverability 3/4, Content 1/1, Bot Access 2/2, API/MCP up to 4/7 → expected Level 2.

---

## Scope summary

| # | Fix | Surface | Moves | Confidence |
|---|---|---|---|---|
| 1 | `Link:` response headers | new middleware | Discoverability +1 | high |
| 2 | Content Signals + explicit AI-bot rules | edit robots.txt string | Bot Access +1 | high |
| 3 | `/.well-known/api-catalog` | new route | API/MCP +1 | high |
| 4 | MCP Server Card `/.well-known/mcp/server-card.json` | new route | API/MCP +1 | high |
| 5 | Markdown negotiation (`Accept: text/markdown`) | new middleware + renderers | Content +1 | high |
| 6 | Agent Skills index `/.well-known/agent-skills/index.json` | new route | API/MCP +1 | medium (emerging) |
| 7 | WebMCP client tool | edit HTML renderers (adds `<script>`) | API/MCP +1 | low (experimental, phase 2) |
| D | DNS-AID records | Cloudflare DNS dashboard (NOT worker) | Discoverability +1 | document only |
| X | OAuth/Auth/Commerce stubs | — | — | **excluded (dishonest)** |
| C | Stale `llms.txt` score fields | edit llms.txt renderer | correctness, not a check | flagged optional |

---

## Implementation

### 1. Link response headers (RFC 8288)

**Why:** Scanner found no `Link` header on `/`. It wants agents pointed to discovery resources via HTTP headers.

**How (additive middleware):** Add a Hono middleware registered *before* routes that sets a `Link` header on HTML/text responses only. It must not overwrite any existing `Link` header and must not touch `/v1/*` JSON.

```ts
// after app.onError, before the last_updated middleware
app.use("*", async (c, next) => {
  await next();
  const ct = c.res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html") && !ct.includes("text/plain")) return;
  if (c.res.headers.has("link")) return;
  c.res.headers.set("Link", [
    '</.well-known/api-catalog>; rel="api-catalog"',
    '</openapi.json>; rel="service-desc"; type="application/json"',
    '</docs>; rel="service-doc"',
    '</.well-known/mcp/server-card.json>; rel="mcp-server"',
    '</llms.txt>; rel="alternate"; type="text/plain"',
    '</sitemap.xml>; rel="sitemap"',
  ].join(", "));
});
```

**Note:** middleware ordering — header mutation must happen *after* `await next()` and must clone-safely co-exist with the `last_updated` middleware (which rebuilds the Response for JSON). Since this guard skips non-HTML/text, there is no collision. Verify both middlewares run (Hono runs `app.use` in registration order).

**Files:** `src/index.ts` (new middleware block).

### 2. Content Signals + explicit AI-bot rules (robots.txt)

**Why:** Bot Access 1/2 — no `Content-Signal` directives. AI-bot wildcard already passes but explicit groups strengthen it.

**How:** Replace the robots.txt string. Default content policy = permissive (directory *wants* to be consumed). Confirm `ai-train` stance with operator before ship.

```
# Content usage preferences — https://contentsignals.org
User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=yes
Allow: /
Disallow: /v1/

# Explicit AI crawler allowances (advisory; wildcard already covers these)
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Claude-Web
User-agent: Google-Extended
User-agent: PerplexityBot
User-agent: CCBot
User-agent: Bytespider
Allow: /
Disallow: /v1/

Sitemap: https://toolidx.dev/sitemap.xml
```

**Open item:** confirm the exact `Content-Signal` grammar (comma-separated `key=value`, placed under a `User-agent` group) against contentsignals.org before ship. The scanner's own guidance: `Content-Signal: ai-train=no, search=yes, ai-input=no`.

**Files:** `src/index.ts` (`/robots.txt` route string).

### 3. API Catalog — `/.well-known/api-catalog` (RFC 9727)

**Why:** API/MCP 0/7 — no catalog. Scanner wants `application/linkset+json` with a `linkset` array.

**How (new route):**

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
    "Content-Type": "application/linkset+json",
    "Cache-Control": "public, max-age=3600",
  })
);
```

**Critical:** Content-Type must be `application/linkset+json` (not `application/json`) or the `last_updated` middleware will mutate it and the scanner may reject it. Confirm exact relation-array shape against **RFC 9727 Appendix A** before ship.

**Files:** `src/index.ts` (new route, registered before `fromHono`).

### 4. MCP Server Card — `/.well-known/mcp/server-card.json` (SEP-1649)

**Why:** Scanner fetched our existing `/.well-known/mcp.json` (which *does* contain top-level `name`) and still failed it, demanding the canonical SEP card at `/.well-known/mcp/server-card.json` with `serverInfo.name`.

**How (new route — keep existing `/.well-known/mcp.json` for back-compat):**

```ts
app.get("/.well-known/mcp/server-card.json", async (c) => {
  const meta = await c.env.DB.prepare(
    "SELECT value FROM metadata WHERE key = 'last_updated'"
  ).first<{ value: string }>();
  return c.json({
    serverInfo: { name: "toolidx", version: "0.1.0" },
    description: "Independent MCP server directory and verification service",
    capabilities: { /* per SEP-1649 schema */ },
    // transport endpoint: toolidx is a REST directory, NOT a live MCP server.
    // Confirm whether SEP-1649 requires a transport block for a directory-of-servers
    // vs. an actual MCP endpoint — may need rel to openapi instead.
    api: { rest: "https://toolidx.dev/v1", openapi: "https://toolidx.dev/openapi.json" },
    lastUpdated: meta?.value ?? null,
  });
});
```

**Critical open item:** toolidx is a *directory of* MCP servers, not itself an MCP server with a transport. SEP-1649 server cards assume a transport endpoint. Verify against the SEP-2127 PR (`modelcontextprotocol/modelcontextprotocol#2127`) whether a directory should publish a server card at all, or whether the right shape omits/adapts the transport block. Do not emit an invalid card. If SEP requires a transport we cannot honestly provide, document and skip rather than fake it.

**Files:** `src/index.ts` (new route).

### 5. Markdown content negotiation

**Why:** Content 0/1 — `Accept: text/markdown` on `/` returns `text/html`.

**How (additive middleware, short-circuits before HTML routes):** A middleware that, when `Accept: text/markdown` is present for `/`, `/server/:id`, `/category/:slug`, returns a markdown render with `Content-Type: text/markdown; charset=utf-8` and `Vary: Accept`. Browsers (HTML default) are unaffected.

- Homepage markdown: reuse `renderLlmsTxt()` (`src/pages/llmstxt.ts`) — it is already valid markdown — or a dedicated `renderHomeMarkdown()`.
- Server/category markdown: new lightweight renderers from the same DB rows the HTML handlers use. Minimum viable to pass the scanner is the **homepage**; full coverage is better agent UX.

**Implementation note:** add `Vary: Accept` so caches don't serve markdown to browsers. Keep this middleware self-contained (does its own DB reads) so it does not modify the existing `/`, `/server/:id`, `/category/:slug` handlers.

**Files:** `src/index.ts` (new middleware), optional `src/pages/markdown.ts` (new renderers).

### 6. Agent Skills index — `/.well-known/agent-skills/index.json` (RFC v0.2.0)

**Why:** API/MCP — emerging skills discovery. Low cost (static-ish route). Must be honest: only list capabilities toolidx actually exposes (search, lookup, verification data).

**How (new route):** `$schema` + `skills[]`, each `{ name, type, description, url, sha256 }`. The `sha256` is a digest of the referenced skill artifact — confirm what it should digest (the linked doc/endpoint) per the Cloudflare `agent-skills-discovery-rfc` v0.2.0 before ship; do not emit a placeholder hash.

**Files:** `src/index.ts` (new route).

### 7. WebMCP (phase 2 — experimental, optional)

**Why:** API/MCP — exposes a site tool to in-browser agents via `navigator.modelContext.provideContext()`.

**How:** Inject a `<script>` into the HTML page renderers registering one honest tool, e.g. `search_mcp_servers` that calls `/v1/servers?...`. This is the **only** item that edits existing HTML renderers (`src/pages/landing.ts` etc.), so it is the least "pure additive."

**Recommendation:** defer to a follow-up unless the operator wants it now. It is origin-trial-era and has near-zero consumers.

**Files:** `src/pages/landing.ts` (+ optionally serverDetail/categoryDetail) — adds a script block only.

### D. DNS-AID (document only — NOT worker code)

Cannot be done from the Worker. Requires, in the Cloudflare DNS dashboard for `toolidx.dev`:
- SVCB/HTTPS records at `_index._agents.toolidx.dev` (and optionally `_mcp._agents.toolidx.dev`) with `alpn` + endpoint params per the DNS-AID IETF draft (uses RFC 9460 SVCB).
- DNSSEC enabled on the zone so resolvers return authenticated data.

Listed here so it is not forgotten; apply manually. Worth +1 Discoverability (→ 4/4).

### X. Excluded — and why

- **OAuth/OIDC discovery, OAuth Protected Resource, Auth.md** — the `/v1/*` API is unauthenticated. Publishing these advertises token flows that do not exist; agents that follow them break. Dishonest. Revisit only if/when real auth is added.
- **Commerce (x402, MPP, UCP, ACP)** — not scored, and toolidx has no commerce. Would mean fabricating payment endpoints.
- **Web Bot Auth** (`/.well-known/http-message-signatures-directory`) — for signing *outbound* bot requests; irrelevant to a public read API.

### C. Flagged correctness item (separate from scoring)

`src/pages/llmstxt.ts` still advertises `quality_score` and `sanity_score` in the "Server Record Fields" section, but commit history (v11: "drop score/verdict model end-to-end") removed them. Agents reading `llms.txt` get fields that no longer exist. **Recommend** a one-line cleanup to remove/replace those two bullets with the current `coverage` model. Not an isitagentready check — pure correctness. Confirm against the live `/v1/servers/:id` response shape before editing.

---

## Verification

1. **Local:** `npx wrangler dev`, then for each new surface:
   - `curl -I http://localhost:8787/` → assert `Link:` header present, contains `api-catalog`.
   - `curl -H "Accept: text/markdown" -I http://localhost:8787/` → assert `Content-Type: text/markdown` + `Vary: Accept`.
   - `curl http://localhost:8787/.well-known/api-catalog` → valid JSON, `Content-Type: application/linkset+json`.
   - `curl http://localhost:8787/.well-known/mcp/server-card.json` → has `serverInfo.name`.
   - `curl http://localhost:8787/.well-known/agent-skills/index.json` → `$schema` + `skills[]`.
   - `curl http://localhost:8787/robots.txt` → contains `Content-Signal:`.
   - **Regression:** `curl http://localhost:8787/` (no Accept) → still `text/html`; `curl http://localhost:8787/v1/status` → unchanged JSON with `last_updated` (Link middleware must NOT touch it).
2. **Tests:** run existing suite (`tests/`) to confirm no `/v1/*` regression. Add route tests for each new well-known path.
3. **Deploy + re-scan:** `wrangler deploy`, then re-run `isitagentready.com/toolidx.dev` (browser, JS-rendered) and confirm category scores rose. Target ≥ Level 2.

## Risks / open items to resolve during implementation
- Exact `Content-Signal` grammar (contentsignals.org) — #2.
- RFC 9727 linkset relation-array shape (Appendix A) — #3.
- Whether SEP-1649 server card is even appropriate for a *directory* (vs. a live MCP server) and its required transport block — #4. **If it demands a transport we can't honestly provide, skip and document.**
- Agent Skills `sha256` semantics (what it digests) — #6.
- Middleware ordering vs. the existing `last_updated` JSON middleware — #1.
