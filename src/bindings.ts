export interface Env {
	DB: D1Database;
	TOOLIDX_API_KEY: string;
	/** Gitea token for agenticwatch-results archive writes. Set via: wrangler secret put GITEA_TOKEN */
	GITEA_TOKEN: string;
}
