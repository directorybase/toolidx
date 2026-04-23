-- QC timing and behavioural flags for agent consumption
ALTER TABLE servers ADD COLUMN hangs_on_start INTEGER DEFAULT 0;   -- 1 if initialize timed out (never spoke MCP)
ALTER TABLE servers ADD COLUMN tools_list_duration_ms INTEGER;     -- ms from initialized→tools/list response
ALTER TABLE servers ADD COLUMN qc_platform TEXT;                   -- "github" | "gitlab" | "local"
