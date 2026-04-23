-- Add server_version and protocol_version captured during QC install test
ALTER TABLE servers ADD COLUMN server_version TEXT;
ALTER TABLE servers ADD COLUMN protocol_version TEXT;
