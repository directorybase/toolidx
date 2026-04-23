# toolidx

**Independent MCP server directory and verification service.**

[toolidx.dev](https://toolidx.dev) · [API Docs](https://toolidx.dev/docs) · [OpenAPI](https://toolidx.dev/openapi.json) · [llms.txt](https://toolidx.dev/llms.txt)

---

## What it is

toolidx indexes, evaluates, and verifies MCP (Model Context Protocol) servers. Each listing passes through a multi-stage pipeline: AI description generation, multi-model Sanity Panel cross-review, a quality gate, and a live QC install test. The result is a structured, queryable directory agents can trust.

**2,000+ servers indexed. Machine-readable. Agent-first.**

---

## API

Base URL: `https://toolidx.dev`

| Endpoint | Description |
|---|---|
| `GET /v1/status` | Service health and index metadata |
| `GET /v1/servers` | List servers — filter by `status`, `qc_status`; paginate with `limit`/`offset` |
| `GET /v1/servers/:id` | Full server record including tool schemas and eval scores |
| `GET /openapi.json` | OpenAPI 3.1 specification |
| `GET /llms.txt` | LLM-readable service guide |
| `GET /.well-known/mcp.json` | Machine-readable service manifest |

Every response includes `last_updated` (ISO 8601 UTC) so agents can assess data freshness without a separate call.

### Quick start for agents

```bash
# List verified, installable servers
curl https://toolidx.dev/v1/servers?status=active&qc_status=passed

# Get a specific server
curl https://toolidx.dev/v1/servers/github-com-modelcontextprotocol-servers

# Check service status
curl https://toolidx.dev/v1/status
```

### Server record fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Stable slug from repository URL |
| `name` | string | Display name |
| `description` | string | AI-generated, quality-gated description |
| `install_command` | string | Verified install command |
| `package_type` | string | `npm` \| `uvx` \| `pip` |
| `tool_schemas` | array | Tool definitions from live QC install test |
| `tool_count` | number | Number of tools exposed |
| `qc_status` | string | `pending` \| `passed` \| `failed` \| `error` \| `skipped` |
| `quality_score` | number | Weighted eval score 0–10 |
| `sanity_score` | number | Multi-model consensus score 0–10 |
| `status` | string | `active` \| `pending` \| `rejected` |

---

## Verification pipeline

1. **AI description** — multi-model generation from README and source
2. **Sanity Panel** — 5 independent agents cross-review each listing; divergence is flagged
3. **Quality gate** — Claude API cold reviewer scores on Accuracy (30%), Specificity (25%), Actionability (20%), Trust (15%), Completeness (10%); verdict: approve / revise / reject
4. **QC install test** — live `npm`/`uvx`/`pip` install, tool schema introspection via `tools/list`

---

## Stack

- **Runtime:** Cloudflare Workers
- **Framework:** [Hono](https://hono.dev) + [Chanfana](https://chanfana.com) (OpenAPI 3.1)
- **Database:** Cloudflare D1 (SQLite)
- **Language:** TypeScript

---

## Development

```bash
npm install
npx wrangler d1 migrations apply toolidx --local
npx wrangler dev
```

### Environment

| Variable | Where | Description |
|---|---|---|
| `TOOLIDX_API_KEY` | Cloudflare Worker secret | Required for write endpoints (`X-API-Key` header) |

### Import from source data

```bash
GITEA_TOKEN=your_token TOOLIDX_API_KEY=your_key python3 scripts/import-from-gitea.py
```

---

## Related

- [AgenticWatch](https://agenticwatch.dev) — human-facing MCP server directory, powered by toolidx data
- [directorybase](https://github.com/directorybase) — the org behind toolidx and AgenticWatch
