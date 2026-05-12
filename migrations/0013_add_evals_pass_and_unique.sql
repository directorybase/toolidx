-- Migration 0013: add pass column + unique index to evals
-- Spec: outputs/2026-05-11-claude-toolidx-multi-agent-review-surface-plan-v5.md §3.1
--
-- 1. Add the pass column. Default 3 = final-pass (most recent reasoning); existing rows
--    (none today: SELECT COUNT(*) FROM evals = 0) get the safe default. Once data lands
--    via §3.3, the bridge writes the correct pass per row.
ALTER TABLE evals ADD COLUMN pass INTEGER NOT NULL DEFAULT 3;

-- 2. Unique index for the UPSERT in §3.2. Required for ON CONFLICT to resolve a
--    target — without it, UPSERT silently degrades to INSERT and duplicates land.
CREATE UNIQUE INDEX IF NOT EXISTS ux_evals_server_agent_lens_pass
  ON evals(server_id, agent, lens, pass);
