/**
 * Does the configured user token reach the project's repository, and with
 * push rights? (mt#5154, the 22:35Z addendum)
 *
 * `session_pr_merge` on flowtato PR #1 failed with "Resource not accessible
 * by personal access token": `github.token` was a fine-grained PAT whose
 * repository access did not include the newly onboarded repo. `minsky setup`
 * checks the App installations' coverage (`app-coverage.ts`); nothing checked
 * the PAT's, so the loop ran all the way to merge before failing.
 *
 * One documented read: GitHub REST "Get a repository" (`GET /repos/{owner}/{repo}`)
 * returns the authenticated caller's `permissions` object
 * (`admin` / `maintain` / `push` / `triage` / `pull`) on 200, and 403 / 404 when
 * the caller cannot access it — the docs do not distinguish the two for a
 * token lacking access, and the remedy is the same, so neither does this.
 * `src/commands/github/test.ts` step 4 reads the same field for the CLI.
 *
 * Never throws; a transport failure is `unknown` with the reason, which the
 * doctor renders as an unverified check rather than a missing grant.
 */

export type TokenRepoAccess =
  | { state: "push"; repo: string }
  | { state: "read-only"; repo: string }
  | { state: "not-accessible"; repo: string; status: number }
  | { state: "unknown"; repo: string; reason: string };

export interface CheckTokenRepoAccessDeps {
  /** Test seam; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

export async function checkTokenRepoAccess(
  ownerRepo: string,
  token: string,
  deps: CheckTokenRepoAccessDeps = {}
): Promise<TokenRepoAccess> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.apiBaseUrl ?? "https://api.github.com";
  try {
    const response = await fetchImpl(`${base}/repos/${ownerRepo}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (response.status === 403 || response.status === 404) {
      return { state: "not-accessible", repo: ownerRepo, status: response.status };
    }
    if (!response.ok) {
      return { state: "unknown", repo: ownerRepo, reason: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as { permissions?: { push?: boolean } };
    return body.permissions?.push === true
      ? { state: "push", repo: ownerRepo }
      : { state: "read-only", repo: ownerRepo };
  } catch (error) {
    return {
      state: "unknown",
      repo: ownerRepo,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
