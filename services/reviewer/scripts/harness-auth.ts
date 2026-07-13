/**
 * Shared GitHub auth resolution for harness scripts.
 *
 * Reads `OCTOKIT_AUTH` first (dedicated harness token for rate-limit isolation),
 * then falls back to `GITHUB_TOKEN` (user's PAT via `gh auth token`).
 *
 * When `OCTOKIT_AUTH` is set to a GitHub App installation token, the script
 * authenticates as the App identity, isolating its rate-limit budget from the
 * user PAT. See services/reviewer/HARNESS.md for provisioning instructions.
 *
 * @see mt#1502 — rate-limit isolation for harness scripts
 */

export function resolveGitHubToken(): string | undefined {
  return process.env.OCTOKIT_AUTH || process.env.GITHUB_TOKEN;
}

export function resolveGitHubTokenOrSkip(): string {
  const token = resolveGitHubToken();
  if (!token) {
    console.log(
      "SKIP: Neither OCTOKIT_AUTH nor GITHUB_TOKEN set; skipping live test.\n" +
        "HINT: set OCTOKIT_AUTH to a GitHub App installation token for rate-limit isolation,\n" +
        "or GITHUB_TOKEN=$(gh auth token) for local dev."
    );
    process.exit(0);
  }
  return token;
}

export function getAuthSource(): "OCTOKIT_AUTH" | "GITHUB_TOKEN" | "none" {
  if (process.env.OCTOKIT_AUTH) return "OCTOKIT_AUTH";
  if (process.env.GITHUB_TOKEN) return "GITHUB_TOKEN";
  return "none";
}
