-- Migration 0014: evals.description (per-agent-pass description text)
--                  + servers.composite_override (operator-curated composite text)
-- Spec: outputs/2026-05-12-claude-toolidx-multi-agent-review-surface-plan-v6.md §3.1b

-- 1. Per-agent description per pass. Populated by the bridge (§3.3) from status.json.
--    Used by §3.7 composite selection and (via API) by §3.5 per-agent panels.
--    Null when the source pass produced commentary-only (e.g., Pass 2 cross-review
--    notes without a fresh description).
ALTER TABLE evals ADD COLUMN description TEXT;

-- 2. Operator-curated composite override per server. When non-null, replaces the
--    Pass-3-selection heuristic in §3.7. Set via PATCH /v1/servers/:id or direct
--    D1 UPDATE.
ALTER TABLE servers ADD COLUMN composite_override TEXT;
