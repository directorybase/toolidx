-- Migration number: 0003	 2026-04-22T00:00:00.000Z
CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    repository_url TEXT,
    package_name TEXT,
    package_type TEXT,             -- 'npm' | 'uvx' | 'pip'
    install_command TEXT,
    homepage_url TEXT,
    tags TEXT,                     -- JSON array
    tool_schemas TEXT,             -- JSON array from QC introspection
    tool_count INTEGER,
    qc_status TEXT DEFAULT 'pending',  -- 'pending' | 'passed' | 'failed' | 'error' | 'skipped'
    qc_error TEXT,
    qc_tested_at TEXT,
    sanity_score REAL,
    quality_score REAL,
    status TEXT DEFAULT 'active',  -- 'active' | 'pending' | 'rejected'
    source TEXT,                   -- 'gitea-import' | 'submission' | 'api'
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    agent TEXT NOT NULL,
    lens TEXT NOT NULL,            -- 'accuracy' | 'specificity' | 'actionability' | 'trust' | 'completeness'
    score REAL,                    -- 0-10
    verdict TEXT,                  -- 'approve' | 'revise' | 'reject'
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_servers_status_quality ON servers(status, quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_servers_qc_status ON servers(qc_status);
CREATE INDEX IF NOT EXISTS idx_evals_server_id ON evals(server_id);

-- Keep metadata.last_updated current whenever servers change
CREATE TRIGGER IF NOT EXISTS trg_servers_last_updated_insert
AFTER INSERT ON servers
BEGIN
    INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_updated', datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_servers_last_updated_update
AFTER UPDATE ON servers
BEGIN
    INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_updated', datetime('now'));
END;
