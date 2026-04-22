import type { AppContext } from "../types";

export function requireAuth(c: AppContext): Response | null {
	const key = c.req.header("X-API-Key");
	if (!key || key !== c.env.TOOLIDX_API_KEY) {
		return c.json(
			{ success: false, errors: [{ code: 401, message: "Unauthorized" }] },
			401,
		);
	}
	return null;
}
