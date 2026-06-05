# toolidx lab-side Sanity Panel bridge

Replaces the Cloudflare-cron bridge that lived in `src/lib/sanityBridge.ts`.

## Why this exists

The edge bridge hit two walls in production (2026-05-30):

1. **Reachability** — Cloudflare Workers cannot reach lab IPs (RFC1918 LAN nor
   Tailscale 100.x). The public tunnel works for light calls but `/contents/jobs`
   on the 318-entry directory times out (Gitea enriches every entry with last-commit
   metadata before paginating).
2. **CPU ceiling** — Even past that, the scheduled handler hit "Exceeded CPU Limit"
   at ~62/317 jobs. Workers' per-invocation execution cap can't sweep the full set.

The toolidx `POST /internal/sanity-ingest` endpoint was always designed for an
external pusher (X-API-Key auth, batches up to 100 rows, per-row try/except,
orphan bucketing). This script is that pusher.

## Architecture

```
dragonstone (cron */15)
  → sanity_bridge.py
      ├─ GET Gitea (Tailscale LAN, fast, unmetered)
      │     /branches/main + /git/trees/<sha> — list 318 job dirs (3 light calls)
      │     /contents/jobs/X/crosscheck       — 5 agent dirs per job
      │     /raw/jobs/X/...                   — describe.job.json, status.json, pass{1,3}.json
      ├─ normalize_job()         — mirror of TS normalizeJob
      └─ POST toolidx (public)
            /internal/sanity-ingest, X-API-Key, ≤100 rows/batch

Note: /contents/jobs (the obvious listing endpoint) is unusable on the 318-entry
dir even over LAN — Gitea enriches every entry with last-commit metadata before
paginating, which exceeds any reasonable timeout. Git Trees returns raw
{path,type,sha} entries with no enrichment. Verified 2026-05-30 across both
Tailscale-direct and Cloudflare-tunnel paths.
```

Normalization logic is a 1:1 port of `src/lib/sanityBridge.ts` `normalizeJob`
(same AGENT_TO_LENS map, same status.json-gated pass-3 fetch, same HALT-SIGNAL on
layout mismatch). Drift between this script and `sanityIngest.ts`'s zod schema
should surface as orphan/other rejections; both files live in this repo to make
that drift catchable in a single diff.

## Run locally (verification only — no live writes)

```bash
cd /Users/gregory/Developer/toolidx/scripts/lab-bridge
GITEA_TOKEN=$(python3 -c "import netrc; print(netrc.netrc().authenticators('100.93.110.41')[2])") \
TOOLIDX_API_KEY=<key> \
BRIDGE_MODE=dry-run \
  python3 sanity_bridge.py
```

Expect:
- `listed 317` (or current count) `job dirs`
- per-job `pass3 SKIPPED` lines for agents where status.pass3=false
- final `DRY-RUN samples` block: one sample per (agent, pass) tuple with lens + truncated description
- **No HALT-SIGNAL lines.** If any appear, the upstream layout drifted from v11 §1.

## Deploy to dragonstone

```bash
# from iMac, chained through robodorm (per docs/lessons-learned)
rsync -av sanity_bridge.py README.md \
    -e "ssh -J robodorm" \
    dragonstone:/opt/toolidx-bridge/

# on dragonstone, set env in a sourceable file:
cat > /opt/toolidx-bridge/env <<'EOF'
export GITEA_TOKEN=...
export TOOLIDX_API_KEY=...
export GITEA_BASE=http://100.93.110.41:30008
export TOOLIDX_BASE=https://toolidx.dev
export BRIDGE_MODE=dry-run
EOF
chmod 600 /opt/toolidx-bridge/env

# crontab -e:
*/15 * * * * . /opt/toolidx-bridge/env && /usr/bin/python3 /opt/toolidx-bridge/sanity_bridge.py >> /var/log/toolidx-bridge.log 2>&1
```

Verify with `tail -f /var/log/toolidx-bridge.log` over the next 1-2 ticks.

## Modes

- `dry-run` (default) — fetch + normalize + sample log. **No POST.**
- `live` — POST mode=live → endpoint UPSERTs rows. Use only after dry-run verifies cleanly.
- `backfill` — POST mode=backfill → endpoint UPSERTs but logs as backfill server-side.

Flip via the env file:
```bash
sed -i 's/BRIDGE_MODE=dry-run/BRIDGE_MODE=live/' /opt/toolidx-bridge/env
```

## Required secrets (4 places now — was 3 pre-this-script)

`TOOLIDX_API_KEY` rotation registry:
1. Worker secret (`wrangler secret put TOOLIDX_API_KEY`)
2. GitHub Actions secret
3. GitLab CI variable
4. **dragonstone `/opt/toolidx-bridge/env`** (this script — added 2026-05-30)

Rotate all four together or CI/CD silently 401s.

## Acceptance criteria (per v11 §AC-BRIDGE)

A dry-run is clean when:
- `listed N job dirs` matches Gitea's `/contents/jobs` count
- Every (agent, pass) tuple sample has `description != null` and `lens == AGENT_TO_LENS[agent]`
- Zero `HALT-SIGNAL` lines
- Zero `normalizer failed` entries

A live run is clean when:
- `accepted` equals the dry-run's row count (modulo legitimate orphans for jobs
  whose product_url derives a server_id not yet in `servers`)
- `orphans` and `other_errors` lists are inspected and explained
- `/v1/servers/:id/evals` on a covered server returns `coverage.agents_with_pass3 >= 1`
- `/server/:id` HTML renders a `.composite-provenance` line (and `.desc-evolution`
  when both pass-1 and pass-3 are present)
