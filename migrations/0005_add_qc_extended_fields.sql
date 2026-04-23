-- Extended QC fields captured during live install test
ALTER TABLE servers ADD COLUMN capabilities TEXT;         -- JSON: full MCP capabilities object from initialize
ALTER TABLE servers ADD COLUMN resources_list TEXT;       -- JSON: array from resources/list (if supported)
ALTER TABLE servers ADD COLUMN prompts_list TEXT;         -- JSON: array from prompts/list (if supported)
ALTER TABLE servers ADD COLUMN has_destructive_tools INTEGER DEFAULT 0;  -- any tool with destructiveHint
ALTER TABLE servers ADD COLUMN all_tools_readonly INTEGER DEFAULT 0;     -- all tools have readOnlyHint
ALTER TABLE servers ADD COLUMN install_duration_ms INTEGER;              -- ms from process start to initialize response
ALTER TABLE servers ADD COLUMN requires_env_vars INTEGER DEFAULT 0;      -- crashed immediately, likely needs API key
