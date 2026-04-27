-- Migration 0012: Server-level failure_class rollup
-- Stores the classified failure mode for each server (latest classification).
-- Per-run failure class lives in qc_runs.error_class (migration 0011).

ALTER TABLE servers ADD COLUMN failure_class TEXT;

CREATE INDEX IF NOT EXISTS idx_servers_failure_class
    ON servers (failure_class) WHERE failure_class IS NOT NULL;
