-- Track last-known npm package version for change detection
ALTER TABLE servers ADD COLUMN npm_version TEXT;
