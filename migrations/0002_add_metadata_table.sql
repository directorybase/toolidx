-- Migration number: 0002	 2026-04-22T00:00:00.000Z
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO metadata (key, value)
VALUES ('last_updated', datetime('now'));
