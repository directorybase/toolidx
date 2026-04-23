-- Server instructions text returned in MCP initialize response (newer protocol feature)
ALTER TABLE servers ADD COLUMN server_instructions TEXT;
