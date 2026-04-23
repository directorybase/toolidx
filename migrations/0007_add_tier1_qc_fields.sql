-- Tier 1 QC fields: discovery metadata + quality heuristics
ALTER TABLE servers ADD COLUMN min_node_version TEXT;          -- from package.json engines.node
ALTER TABLE servers ADD COLUMN description_quality_score REAL; -- heuristic 0-10: avg desc length + coverage
ALTER TABLE servers ADD COLUMN external_deps_detected TEXT;    -- JSON array: binaries detected from stderr
ALTER TABLE servers ADD COLUMN setup_complexity TEXT;          -- "low" | "medium" | "high"
