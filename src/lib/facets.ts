// Facet renderers for per-server runtime/install metadata.
// Per the operator-approved 2026-05-11 taxonomy proposal: 8 of 10 facets
// are derivable from existing D1 columns. transport + provenance need a
// schema migration and are deferred to Phase 3.5.

export type Variant = "good" | "neutral" | "warn" | "bad" | "info";
export type Facet = { key: string; label: string; value: string; variant: Variant; title?: string };

type ServerRow = Record<string, unknown>;

function s(v: unknown): string | null {
	if (v == null) return null;
	const out = String(v).trim();
	return out.length ? out : null;
}
function n(v: unknown): number | null {
	if (v == null) return null;
	const num = typeof v === "number" ? v : Number(v);
	return Number.isFinite(num) ? num : null;
}
function b(v: unknown): boolean | null {
	if (v == null) return null;
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
	return null;
}

// install_type — package_type column (npm | pypi | docker | uvx | binary | remote)
function facetInstallType(row: ServerRow): Facet | null {
	const v = s(row.package_type);
	if (!v) return null;
	return { key: "install_type", label: v.toUpperCase(), value: v, variant: "info", title: `Install type: ${v}` };
}

// auth_required — derived from requires_env_vars (proxy for needs-credentials)
function facetAuthRequired(row: ServerRow): Facet | null {
	const v = b(row.requires_env_vars);
	if (v == null) return null;
	return v
		? { key: "auth", label: "AUTH", value: "required", variant: "warn", title: "Requires environment variables (likely auth credentials)" }
		: { key: "auth", label: "NO AUTH", value: "none", variant: "good", title: "No env vars required" };
}

// safety — derived from has_destructive_tools + all_tools_readonly
function facetSafety(row: ServerRow): Facet | null {
	const destructive = b(row.has_destructive_tools);
	const readOnly = b(row.all_tools_readonly);
	if (destructive == null && readOnly == null) return null;
	if (readOnly === true) return { key: "safety", label: "READ-ONLY", value: "read_only", variant: "good", title: "All tools are read-only" };
	if (destructive === true) return { key: "safety", label: "DESTRUCTIVE", value: "destructive", variant: "bad", title: "Has destructive tools (writes, deletes)" };
	if (destructive === false && readOnly === false) return { key: "safety", label: "MIXED", value: "mixed", variant: "neutral", title: "Mix of read and write tools" };
	return null;
}

// setup_complexity — direct column (low | medium | high)
function facetSetupComplexity(row: ServerRow): Facet | null {
	const v = s(row.setup_complexity);
	if (!v) return null;
	const variant: Variant = v === "low" ? "good" : v === "medium" ? "neutral" : v === "high" ? "warn" : "info";
	return { key: "setup", label: `SETUP ${v.toUpperCase()}`, value: v, variant, title: `Setup complexity: ${v}` };
}

// runtime_health — derived from hangs_on_start + qc_error
function facetRuntimeHealth(row: ServerRow): Facet | null {
	const hangs = b(row.hangs_on_start);
	const qcError = s(row.qc_error);
	const qcStatus = s(row.qc_status);
	if (hangs === true) return { key: "health", label: "HANGS", value: "hangs", variant: "bad", title: "Server hangs on start during QC" };
	if (qcStatus === "passed" && hangs === false) return { key: "health", label: "STARTS CLEAN", value: "starts", variant: "good", title: "Starts cleanly during QC" };
	if (qcError) return { key: "health", label: "QC ERROR", value: "errored", variant: "bad", title: qcError.slice(0, 120) };
	return null;
}

// schema_cost — derived from schema_weight_chars (token cost proxy)
function facetSchemaCost(row: ServerRow): Facet | null {
	const v = n(row.schema_weight_chars);
	if (v == null || v <= 0) return null;
	const kb = v / 1024;
	let value: string, variant: Variant;
	if (kb < 50)        { value = "low";    variant = "good"; }
	else if (kb < 200)  { value = "medium"; variant = "neutral"; }
	else                { value = "high";   variant = "warn"; }
	return {
		key: "schema_cost",
		label: `SCHEMA ${value.toUpperCase()}`,
		value,
		variant,
		title: `Tool schema weight: ${kb.toFixed(0)}KB (${value} token cost)`,
	};
}

// tool_scope — derived from is_proxy + tool_count
function facetToolScope(row: ServerRow): Facet | null {
	const isProxy = b(row.is_proxy);
	const count = n(row.tool_count);
	if (isProxy === true) return { key: "scope", label: "PROXY", value: "proxy", variant: "info", title: "Proxy/gateway server" };
	if (count == null) return null;
	if (count === 1) return { key: "scope", label: "SINGLE TOOL", value: "single", variant: "neutral", title: "Single-purpose server" };
	if (count > 1) return { key: "scope", label: `${count} TOOLS`, value: "multi", variant: "info", title: `Multi-tool server (${count} tools)` };
	return null;
}

// All facets in display order. verified_status is rendered separately (already
// the prominent badge on per-server pages); it's included here for category
// pages where consistency matters.
const FACET_FNS: Array<(row: ServerRow) => Facet | null> = [
	facetInstallType,
	facetAuthRequired,
	facetSafety,
	facetSetupComplexity,
	facetRuntimeHealth,
	facetSchemaCost,
	facetToolScope,
];

export function facetsFor(row: ServerRow): Facet[] {
	const out: Facet[] = [];
	for (const fn of FACET_FNS) {
		const f = fn(row);
		if (f) out.push(f);
	}
	return out;
}

// Compact subset for server cards on category list pages — shows the 4 most
// distinguishing facets to keep card density manageable.
export function facetsForCard(row: ServerRow): Facet[] {
	const all = facetsFor(row);
	const wanted = new Set(["install_type", "safety", "setup", "schema_cost"]);
	return all.filter(f => wanted.has(f.key));
}
