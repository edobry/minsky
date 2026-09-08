/**
 * GitHub PAT provider (mt#1426).
 *
 * Validate stage hits `GET /user` (any authenticated token succeeds — cheap
 * existence check). Test stage hits `GET /user/repos?per_page=1` to exercise
 * the `repo` scope Minsky actually needs for issue/PR operations. A token
 * that passes validate but fails test is reported as `scopeGap: true`.
 */
import type { CredentialProvider, CredentialCheckResult } from "../types";

const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_REPOS_URL = "https://api.github.com/user/repos?per_page=1";

interface GitHubUser {
  login?: unknown;
}

function commonHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function validateUser(token: string): Promise<CredentialCheckResult> {
  let response: Response;
  try {
    response = await fetch(GITHUB_USER_URL, { method: "GET", headers: commonHeaders(token) });
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 401) {
    return { ok: false, detail: "401 Unauthorized — token invalid or revoked", unauthorized: true };
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
  }

  let user: GitHubUser;
  try {
    user = (await response.json()) as GitHubUser;
  } catch {
    return { ok: false, detail: "response was not valid JSON" };
  }
  const login = typeof user.login === "string" ? user.login : "(unknown)";
  const line = `authenticated as @${login}`;
  // Already state-shaped and short — `status` repeats it (mt#5031).
  return { ok: true, detail: line, status: line };
}

async function testRepoScope(token: string): Promise<CredentialCheckResult> {
  // First confirm the token still authenticates (gives us the @login for the success message).
  const userCheck = await validateUser(token);
  if (!userCheck.ok) {
    return userCheck;
  }

  let response: Response;
  try {
    response = await fetch(GITHUB_REPOS_URL, { method: "GET", headers: commonHeaders(token) });
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 401) {
    return { ok: false, detail: "401 Unauthorized — token invalid or revoked", unauthorized: true };
  }
  if (response.status === 403) {
    // 403 from /user/repos means the token lacks `repo` scope (or equivalent).
    // Authentication is fine; report as scope gap rather than failure.
    return {
      ok: true,
      detail: `${userCheck.detail}; missing \`repo\` scope — repo operations will fail`,
      // The consequence clause is what makes the detail long, and a consequence
      // is not a state. The column carries the gap itself; the identity and the
      // consequence stay in `detail` (mt#5031). Fixed-length rather than
      // interpolating the login, which is unbounded.
      status: "authenticated; no `repo` scope",
      scopeGap: true,
    };
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
  }

  // `detail` appends the scope confirmation (46 chars — the measured column
  // boundary, with no headroom). The column takes the identity alone; "the
  // scope is present" is the unremarkable case and does not need saying there.
  return {
    ok: true,
    detail: `${userCheck.detail}; \`repo\` scope present`,
    status: userCheck.status ?? userCheck.detail,
  };
}

export const githubProvider: CredentialProvider = {
  id: "github",
  displayName: "GitHub",
  configPath: "github.token",
  acquireUrl: "https://github.com/settings/tokens/new",
  scopeGuidance:
    "Generate a classic Personal Access Token (or fine-grained PAT) with `repo` scope. Optionally add `read:org` if you operate against organization repositories.",
  validate: validateUser,
  test: testRepoScope,
};
