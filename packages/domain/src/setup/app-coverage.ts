/**
 * GitHub App installation-coverage check for onboarding (mt#4680).
 *
 * Without this, a repository the Minsky App installation does not cover first
 * announces itself as a bare `404` from `pulls.create` — indistinguishable from
 * "the repository does not exist", and only after the PR branch has already
 * been pushed. `minsky init` and `minsky setup` say nothing about the App at
 * all, so nothing earlier in onboarding can surface it.
 *
 * The check runs on the INSTALLATION token the provider already mints
 * (`GET /installation/repositories`). It deliberately does not use
 * `GET /user/installations/{id}/repositories`, which needs a user access token
 * Minsky does not hold.
 */

import { GitHubAppTokenProvider } from "../auth/github-app-token-provider";
import { getErrorMessage } from "../errors/index";

/**
 * Outcome of the coverage check.
 *
 * `unknown` is deliberately distinct from `not-covered`: a failed check must
 * never render as a missing grant, because the remedy for each is different and
 * telling an operator to grant access they already have wastes the trip.
 */
export type AppCoverageStatus =
  | { state: "covered"; repo: string }
  | { state: "not-covered"; repo: string; coveredCount: number }
  | { state: "no-app-configured" }
  | { state: "unknown"; reason: string };

export interface CheckAppCoverageDeps {
  /** Test seam; defaults to the real App-token-backed provider. */
  provider?: GitHubAppTokenProvider | null;
}

/**
 * Does the configured Minsky GitHub App installation cover `ownerRepo`?
 *
 * Never throws: onboarding must not fail because a coverage probe did. An
 * error becomes `{ state: "unknown" }` carrying the reason, which callers
 * render as an unverified check rather than as a failure.
 */
export async function checkAppCoverage(
  ownerRepo: string,
  deps: CheckAppCoverageDeps = {}
): Promise<AppCoverageStatus> {
  const provider = deps.provider;
  if (!provider) return { state: "no-app-configured" };

  try {
    const coverage = await provider.getInstallationCoverage();
    if (coverage.selection === "all" || coverage.repositories.includes(ownerRepo.toLowerCase())) {
      return { state: "covered", repo: ownerRepo };
    }
    return { state: "not-covered", repo: ownerRepo, coveredCount: coverage.repositories.length };
  } catch (error) {
    return { state: "unknown", reason: getErrorMessage(error) };
  }
}

/**
 * Render a coverage status as an operator-facing line.
 *
 * The `not-covered` message names the concrete remedy, because the whole point
 * is to replace a bare 404 with something actionable.
 */
export function formatAppCoverage(
  status: AppCoverageStatus,
  appSlug = "your Minsky GitHub App"
): string {
  switch (status.state) {
    case "covered":
      return `GitHub App: installation covers ${status.repo}`;
    case "not-covered":
      return [
        `GitHub App: installation does NOT cover ${status.repo}`,
        `  Pull-request creation will fail with a 404 until this is granted.`,
        `  Grant it: GitHub -> Settings -> Applications -> Installed GitHub Apps -> ${appSlug} -> Repository access`,
      ].join("\n");
    case "no-app-configured":
      return "GitHub App: not configured — skipping coverage check";
    case "unknown":
      return `GitHub App: coverage could not be verified (${status.reason})`;
  }
}
