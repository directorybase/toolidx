// Derives a stable, human-readable server ID from a repository URL.
// github.com/owner/repo-name → github-com-owner-repo-name
export function deriveServerId(repositoryUrl: string): string {
	return repositoryUrl
		.replace(/^https?:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/[^a-z0-9]+/gi, "-")
		.toLowerCase()
		.replace(/^-+|-+$/g, "");
}
