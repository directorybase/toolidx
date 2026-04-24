-- Migration 0011: Verified Tool Inventory v1
-- Adds qc_runs, qc_tool_results, tool_test_args, qc_monthly tables
-- and summary columns to servers.

-- -------------------------------------------------------
-- qc_runs: one row per test run per (server, platform)
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS qc_runs (
    run_id                   TEXT PRIMARY KEY,       -- ulid
    server_id                TEXT NOT NULL REFERENCES servers(id),
    platform                 TEXT NOT NULL,          -- 'github' | 'gitlab' | 'cirrus' | ...
    runner_os                TEXT,                   -- 'ubuntu-22.04' | 'macos-14' | ...
    runner_arch              TEXT,                   -- 'x64' | 'arm64' | ...
    runner_runtime_version   TEXT,                   -- e.g. node-20.11.0
    status                   TEXT,                   -- passed | failed | error
    install_duration_ms      INTEGER,
    tools_list_duration_ms   INTEGER,
    tools_tested_count       INTEGER,
    started_at               TEXT NOT NULL,
    finished_at              TEXT,
    error_class              TEXT                    -- install_fail | hang | tools_list_fail | ...
);

CREATE INDEX IF NOT EXISTS idx_qc_runs_server_started
    ON qc_runs (server_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_qc_runs_platform_started
    ON qc_runs (platform, started_at DESC);

-- -------------------------------------------------------
-- qc_tool_results: one row per tool per run
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS qc_tool_results (
    run_id       TEXT NOT NULL REFERENCES qc_runs(run_id),
    server_id    TEXT NOT NULL,
    tool_name    TEXT NOT NULL,
    status       TEXT NOT NULL,     -- working | broken | needs-auth | not-tested | unknown
    latency_ms   INTEGER,
    error_class  TEXT,
    error_sample TEXT,              -- max 500 chars, redacted
    sample_args  TEXT,              -- JSON, what we called it with
    tested_at    TEXT NOT NULL,
    PRIMARY KEY (run_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_qc_tool_results_server_tool_tested
    ON qc_tool_results (server_id, tool_name, tested_at DESC);

-- -------------------------------------------------------
-- tool_test_args: cached args keyed on schema hash
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS tool_test_args (
    schema_hash   TEXT PRIMARY KEY,
    args          TEXT,             -- JSON
    generated_by  TEXT,            -- 'qwen2.5-7b' | 'llama-3-8b' | 'naive'
    generated_at  TEXT,
    validated     INTEGER           -- bool: did it pass the tool when used?
);

-- -------------------------------------------------------
-- qc_monthly: rollup aggregates (90-day purge target)
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS qc_monthly (
    server_id          TEXT NOT NULL,
    platform           TEXT NOT NULL,
    tool_name          TEXT NOT NULL,
    month              TEXT NOT NULL,   -- YYYY-MM
    n_working          INTEGER,
    n_broken           INTEGER,
    n_needs_auth       INTEGER,
    n_not_tested       INTEGER,
    median_latency_ms  INTEGER,
    PRIMARY KEY (server_id, platform, tool_name, month)
);

-- -------------------------------------------------------
-- servers: add summary columns (additive only)
-- -------------------------------------------------------
ALTER TABLE servers ADD COLUMN tool_count_working      INTEGER;
ALTER TABLE servers ADD COLUMN tool_count_needs_auth   INTEGER;
ALTER TABLE servers ADD COLUMN tool_count_broken       INTEGER;
ALTER TABLE servers ADD COLUMN tool_count_not_tested   INTEGER;
ALTER TABLE servers ADD COLUMN platforms_tested        TEXT;    -- JSON array
ALTER TABLE servers ADD COLUMN all_platforms_agree     INTEGER; -- bool
ALTER TABLE servers ADD COLUMN last_qc_run_id          TEXT;    -- FK into qc_runs
