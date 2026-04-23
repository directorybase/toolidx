-- Token efficiency and proxy classification fields
ALTER TABLE servers ADD COLUMN schema_weight_chars INTEGER;  -- total chars of all tool schemas (proxy for agent token cost)
ALTER TABLE servers ADD COLUMN is_proxy INTEGER DEFAULT 0;   -- 1 if this server wraps other MCP servers
