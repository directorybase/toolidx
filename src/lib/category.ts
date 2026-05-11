// Category taxonomy + classifier.
// 16 top-level buckets driven by name+description substring match. Per the
// per-server-pages plan v3 §5.2 + the operator-approved 2026-05-11 taxonomy
// proposal. Order matters: more specific BEFORE more generic where overlap
// risk exists. First-match-wins. "other" is the explicit fallback.

export type Category = { slug: string; displayName: string; tagline: string };

type BucketDef = { slug: string; displayName: string; tagline: string; triggers: string[] };

const BUCKETS: BucketDef[] = [
	{
		slug: "databases",
		displayName: "Databases",
		tagline: "Relational, document, vector, and search databases.",
		triggers: [
			"postgres", "mysql", "mongo", "sqlite", "redis", "clickhouse", "snowflake", "duckdb", "bigquery",
			"supabase", " sql ", "database", "rdbms", "neo4j", "pinecone", "qdrant", "weaviate", "chroma",
			"vector db", "vector store", "elastic search", "elasticsearch", " kdb ", "timescale",
		],
	},
	{
		slug: "browser-automation",
		displayName: "Browser Automation",
		tagline: "Headless browsers, scrapers, web evaluators.",
		triggers: [
			"playwright", "puppeteer", "selenium", "browser automation", "headless browser",
			"scraper", "scraperapi", "scraping", "web automation", "web-eval", "headless chrome",
		],
	},
	{
		slug: "knowledge-memory",
		displayName: "Knowledge & Memory",
		tagline: "Notes, wikis, RAG, persistent agent memory.",
		triggers: [
			"obsidian", "logseq", "roam research", "knowledge graph", "second brain", "personal wiki",
			"narrarium", "ontolog", "memory gateway", "cognitive memory", "context window",
			"context-mode", "persistent memory", "agent memory", " wiki ", "knowledge base",
			" kb ", "documentation server", "fetching documentation", "icons documentation", "hugeicons",
			"confluence", "rag ", "retrieval-augmented",
		],
	},
	{
		slug: "ai-ml",
		displayName: "AI & Machine Learning",
		tagline: "LLMs, embeddings, ML frameworks.",
		triggers: [
			"ollama", "anthropic", "openai", " llm ", "embedding", "huggingface", "langchain",
			"fine-tun", "neural network", "machine learning", " ml model", "claude api", "gemini",
			"model context protocol implementation", "pure functional mcp", "transformer",
		],
	},
	{
		slug: "file-systems",
		displayName: "File Systems",
		tagline: "Local files, object storage, sync, backup.",
		triggers: [
			" s3 ", "dropbox", "google drive", "onedrive", "object storage", "file system",
			"filesystem", "backup", "rclone", "blob storage",
		],
	},
	{
		slug: "cloud-infra",
		displayName: "Cloud & Infrastructure",
		tagline: "AWS, GCP, Azure, Cloudflare, Kubernetes, IaC.",
		triggers: [
			" aws ", " gcp ", "google cloud", "azure", "cloudflare", " vercel", "netlify",
			"kubernetes", " k8s ", "terraform", "ansible", "docker", " ec2", " lambda",
			"serverless", "webmin", "infrastructure as code", "cloud-first",
		],
	},
	{
		slug: "developer-tools",
		displayName: "Developer Tools",
		tagline: "Git hosts, IDEs, CI, project management, MCP tooling.",
		triggers: [
			"github", "gitlab", "bitbucket", " git ", "code review", "linter", "build system",
			"xcode", "compiler", " ide ", "vscode", "intellij", "jetbrains", "package manager",
			"ci/cd", "ci pipeline", "jira", "linear project", "asana", "trello", "monday.com",
			"clickup", "project management", "issue tracker", "kanban", "qase test", "qa sphere",
			"qasphere", "codebeamer", "test management", "mcp server sdk", "mcp-server-sdk",
			"mcp utilities", "mcphub", "mcp gateway", "mcp proxy", "openapi", "postman",
			"agent-infra", "shared utilities", "agent registry", "marketplace", "developer api",
			"api integration",
		],
	},
	{
		slug: "communication",
		displayName: "Communication",
		tagline: "Chat, email, voice, helpdesk, social.",
		triggers: [
			"slack", "discord", "teams app", "telegram", "whatsapp", " sms ", " email ",
			"twilio", "vapi", "voice ai", "messaging", "chat application", "matrix protocol",
			"text-to-speech", " tts ", " voice ", "freshdesk", "zendesk", "intercom", "helpdesk",
			"help desk", "ticketing", "unthread", "support ticket", "linkedin", "twitter ",
			"facebook ", "instagram", "reddit", "social network",
		],
	},
	{
		slug: "productivity",
		displayName: "Productivity",
		tagline: "Calendar, todos, smart home, weather, fitness.",
		triggers: [
			// Word-boundary discipline: short tokens get leading+trailing spaces to
			// avoid matching subwords (e.g., "exercise" matched "to exercise safeJsonLd",
			// "ical" would match every "-ical" English adjective).
			"gmail", "google calendar", "outlook", "calendly", "icalendar", " ical ", "g suite",
			"gsuite", " calendar ", "todo list", "to-do", "notion", "home assistant", "homeassistant",
			" hass", "sonos", "fritzbox", "philips hue", "thinq", " iot ", "smart home",
			"z-wave", "zigbee", "alexa", "homekit", " flight ", " airline ", " hotel ", " booking ",
			"travel ", "google flights", "tripadvisor", " weather ", "strava", " fitness ", " health ",
			" workout ", " exercise ", " wellness ", " calorie ", "step counter", "heart rate",
			"personal data aggregation",
		],
	},
	{
		slug: "data-analytics",
		displayName: "Data & Analytics",
		tagline: "Dashboards, BI, observability, marketing analytics.",
		triggers: [
			"analytics", "dashboard", "bi tool", "metabase", " csv ", "parquet", " etl ", " elt ",
			"uk business intelligence", "sentry", "datadog", "prometheus", "grafana", "observab",
			"logging", "metrics", "tracing", "newrelic", "splunk", "dynatrace", "smartbear",
			"tableau", "looker", "vegalite", "visualization", "google ads", "facebook ads",
			"meta ads", "marketing analytics",
		],
	},
	{
		slug: "security",
		displayName: "Security",
		tagline: "Auth, secrets, vulnerability scanning, compliance.",
		triggers: [
			"oauth", " auth ", " secret", "vault ", "vulnerab", "pentest", "security scan",
			"encryption", " tls ", " ssh ", "kerberos", " rbac ", "compliance",
			"penetration testing", "csrf", "xss",
		],
	},
	{
		slug: "finance-commerce",
		displayName: "Finance & Commerce",
		tagline: "Banking, crypto, payments, e-commerce, CRM, ads.",
		triggers: [
			" bank ", "banking", "crypto", "bitcoin", "ethereum", " defi ", "web3", "wallet",
			"payment", "invoice", "accounting", "monarch", "stocks", "trading", " perp ",
			" dex ", "blockchain", "solana", "jupiter", "xrpl", "xrp ledger", "payclaw", " debt ",
			" bond ", "treasury", "shopify", "stripe", "woocommerce", "magento", "checkout",
			"ecommerce", "e-commerce", "storefront", "product catalog", "polaris ui", "salesforce",
			"hubspot", "pipedrive", "zoho", " crm ", "sales pipeline", "customer relationship",
			"leads ", " seo ", " sem ", "ads campaign", "x algorithm", "twitter algorithm",
			"social media optimizer",
		],
	},
	{
		slug: "media-design",
		displayName: "Media & Design",
		tagline: "Image, video, audio, design tools, gaming.",
		triggers: [
			"image generation", " video ", " audio ", "music", "photo", "podcast", "youtube",
			"spotify", "ffmpeg", " ocr ", "apple music", "reaper daw", " daw ", "blender", "unity",
			"unreal engine", "aseprite", "pixel art", "figma", "3d model", "modeling", "chess",
			"stockfish", "minecraft", " steam ", "game server", "rpg", "dungeons",
			"magic the gathering", "mtg", "trading card", "card game", "design system",
		],
	},
	{
		slug: "automation-os",
		displayName: "Automation & OS",
		tagline: "Workflow orchestration, schedulers, OS-level control.",
		triggers: [
			"workflow", "automation platform", "zapier", " n8n ", "orchestration", "scheduler",
			" cron ", "job queue", "agent orchestration", "opc ua", "industrial system",
			"process management", "operating system", "os shell", "terminal", "command line",
		],
	},
	{
		slug: "search-web",
		displayName: "Search & Web",
		tagline: "Search engines, web fetch, maps, news.",
		triggers: [
			"search engine", "serper", "perplexity", " sonar ", "brave search", "duckduckgo",
			"algolia", "meilisearch", "full-text search", "searxng", "academic search",
			"paper search", "arxiv", " maps ", "geocod", "location service", "openstreetmap",
			"rest api", "graphql endpoint", "http fetch", "url fetch", "news data", "geeknews",
		],
	},
	{
		slug: "other",
		displayName: "Other",
		tagline: "Servers that don't fit the other categories yet.",
		triggers: [], // matched as fallback only; never via trigger scan
	},
];

// Public, ordered list for /category/:slug routing + sitemap + homepage.
export const CATEGORIES: Category[] = BUCKETS.map(b => ({
	slug: b.slug,
	displayName: b.displayName,
	tagline: b.tagline,
}));

// Lookup helper for the route handler.
export function categoryBySlug(slug: string): Category | null {
	return CATEGORIES.find(c => c.slug === slug) ?? null;
}

// Substring-match classifier. First match wins; "other" if nothing matches.
export function classify(name: string | null | undefined, description: string | null | undefined): Category {
	const text = ` ${(name ?? "").toLowerCase()} ${(description ?? "").toLowerCase()} `;
	for (const b of BUCKETS) {
		if (b.slug === "other") continue; // never match via trigger
		for (const t of b.triggers) {
			if (text.includes(t)) {
				return { slug: b.slug, displayName: b.displayName, tagline: b.tagline };
			}
		}
	}
	const fallback = BUCKETS[BUCKETS.length - 1]; // "other"
	return { slug: fallback.slug, displayName: fallback.displayName, tagline: fallback.tagline };
}
