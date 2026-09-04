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
import type { TokenRole } from "../auth/token-provider";
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
  appSlug = "your Minsky GitHub App",
  settingsUrl?: string
): string {
  switch (status.state) {
    case "covered":
      return `GitHub App: installation covers ${status.repo}`;
    case "not-covered":
      return [
        `GitHub App: installation does NOT cover ${status.repo}`,
        `  Pull-request creation will fail with a 404 until this is granted.`,
        // The link is the remedy; the navigation path is the fallback (mt#4695).
        // The linked form still names `appSlug` because that is the ONLY thing
        // distinguishing two uncovered roles — `checkAppRoleCoverage` renders one
        // block per role and both headers read `does NOT cover <repo>`, so dropping
        // the slug here would leave an operator with two identical blocks and two
        // bare URLs.
        settingsUrl
          ? `  Grant ${appSlug} access at ${settingsUrl} — pick ${status.repo} under Repository access, then Save.`
          : `  Grant it: GitHub -> Settings -> Applications -> Installed GitHub Apps -> ${appSlug} -> Repository access`,
      ].join("\n");
    case "no-app-configured":
      return "GitHub App: not configured — skipping coverage check";
    case "unknown":
      return `GitHub App: coverage could not be verified (${status.reason})`;
  }
}

/**
 * The github.com settings page for ONE App installation (mt#4693).
 *
 * Introduced here rather than in `formatAppCoverage` because the grant REQUEST
 * needs it first; mt#4695 applies it to the operator-facing message above.
 *
 * The id is the caller's to supply, read from configuration
 * (`github.serviceAccount.installationId`, or `github.reviewer.serviceAccount`
 * for the reviewer role) — NOT from the token provider, which holds it on a
 * private field. That keeps this a pure function of its argument, so it is
 * assertable without a provider, a network, or a config loader.
 *
 * **This is the FALLBACK, not the source (mt#4764).** `checkAppRoleCoverage`
 * prefers `provider.getInstallationHtmlUrl()` — GitHub's own `html_url` for the
 * installation — and uses this only when that read is unavailable or fails.
 *
 * Why, recorded so the next reader does not re-derive it from the same silence:
 * GitHub configures a PERSONAL-account installation under the user's own
 * Settings > Applications, and an ORGANIZATION installation under that org's
 * Settings > Third-party Access. Those are different pages, and GitHub's docs
 * publish a URL for NEITHER — so this constructed path can only ever be right
 * about one account type. It was verified live against a `target_type: User`
 * installation (mt#4695, `scripts/verify-installation-settings-url.ts`, which
 * returned a byte-identical `html_url`); the ORG case was never observed,
 * because this project has no organization installation to observe. Reading
 * `html_url` makes that observation unnecessary rather than pending.
 *
 * Kept pure deliberately: the purity above is the reason this is still a
 * usable fallback at all — it needs no provider, so it works exactly when the
 * provider path did not.
 */
export function installationSettingsUrl(installationId: number): string | null {
  // Guarded rather than a bare interpolation (PR #3418 R1, non-blocking): a
  // misconfigured id would otherwise render `.../NaN` or `.../-1` into an
  // operator-facing link. `null` is the same answer as "no id configured", and
  // every caller already omits the link on that — a wrong URL is worse than none.
  if (!Number.isInteger(installationId) || installationId <= 0) return null;
  return `https://github.com/settings/installations/${installationId}`;
}

/** One App role, as the caller knows it from configuration. */
export interface AppRoleDescriptor {
  readonly role: TokenRole;
  /** Display slug, e.g. `minsky-ai`. Named, never inferred — it appears in operator-facing text. */
  readonly slug: string;
  /**
   * Installation id from config, when configured. Absent means the CONSTRUCTED
   * fallback link is unavailable — not that no link is (mt#4764): GitHub's own
   * `html_url` is read from the installation object and needs no local id.
   */
  readonly installationId?: number;
}

/** One role's coverage verdict, plus what an operator-facing surface needs to name it. */
export interface AppRoleCoverage extends AppRoleDescriptor {
  readonly status: AppCoverageStatus;
  /**
   * Settings-page link for this role. Present whenever one could be determined
   * AT ALL — from GitHub's `html_url` (read only for a `not-covered` role), or
   * otherwise from `installationId` via `installationSettingsUrl`, for ANY
   * status. Absent only when neither source yielded one.
   *
   * **Populated is not the same as rendered (mt#4764, PR #3511 R3).** A covered
   * role still carries the constructed link here; `formatAppCoverage` simply
   * does not print one for that state. Two earlier versions of this comment got
   * this wrong in opposite directions — "present iff `installationId` was
   * supplied" (false once `html_url` became the source) and then "absent when
   * the role is covered" (false because the constructed fallback still
   * applies). Read the assignment below, not either of those.
   */
  readonly settingsUrl?: string;
}

/**
 * Coverage for EVERY configured App role, not just the implementer (mt#4693 D6).
 *
 * **Why this exists, and why the single-role check above is not enough.**
 * `checkAppCoverage` passes no role, and `getInstallationCoverage(role?)` defaults
 * to the implementer App — so a configured-but-UNCOVERED `minsky-reviewer` was
 * invisible at onboarding. In this project the reviewer bot's APPROVE is a merge
 * gate, so that gap breaks the whole session → PR → review → merge loop with no
 * onboarding signal at all.
 *
 * **The trap this deliberately avoids.** `clientForRole` falls back to the
 * implementer client when the reviewer App is not configured, so asking for the
 * reviewer's coverage unconditionally would return the IMPLEMENTER's coverage
 * under a reviewer label — two identical verdicts, one of them a lie. Roles are
 * therefore filtered through `isRoleConfigured` BEFORE their coverage is read.
 */
export async function checkAppRoleCoverage(
  ownerRepo: string,
  roles: readonly AppRoleDescriptor[],
  deps: CheckAppCoverageDeps = {}
): Promise<AppRoleCoverage[]> {
  const provider = deps.provider;
  if (!provider) {
    return roles.map((r) => ({ ...r, status: { state: "no-app-configured" } as const }));
  }

  const results: AppRoleCoverage[] = [];
  for (const descriptor of roles) {
    if (!provider.isRoleConfigured(descriptor.role)) continue;

    let status: AppCoverageStatus;
    try {
      const coverage = await provider.getInstallationCoverage(descriptor.role);
      status =
        coverage.selection === "all" || coverage.repositories.includes(ownerRepo.toLowerCase())
          ? { state: "covered", repo: ownerRepo }
          : { state: "not-covered", repo: ownerRepo, coveredCount: coverage.repositories.length };
    } catch (error) {
      // Same contract as `checkAppCoverage`: a probe that could not run is
      // `unknown`, never `not-covered` — the remedies differ.
      status = { state: "unknown", reason: getErrorMessage(error) };
    }

    // Prefer GitHub's own answer to the constructed path (mt#4764). An
    // ORG-owned installation is configured under that organization's settings,
    // not the user's, so a constructed `/settings/installations/<id>` can only
    // ever be right about one account type; `html_url` is right about both.
    //
    // Fetched ONLY for `not-covered` — the one state whose rendered line
    // actually prints a link. A covered role prints none, and `unknown` means
    // the coverage probe already failed, so a second call there is waste that
    // amplifies whatever transient failure or rate limit caused the first
    // (PR #3511 R1). Note the OTHER states still get a `settingsUrl` below,
    // from the constructed fallback — this condition governs the API CALL, not
    // whether the field is populated.
    //
    // The `typeof` guard is load-bearing, not defensive style: every fake
    // provider in the tests is built with `as unknown as GitHubAppTokenProvider`,
    // so a provider missing this method is a RUNTIME throw the compiler cannot
    // see. `getInstallationHtmlUrl` already returns `null` on its own failures.
    const authoritativeUrl =
      status.state === "not-covered" && typeof provider.getInstallationHtmlUrl === "function"
        ? await provider.getInstallationHtmlUrl(descriptor.role)
        : null;

    const settingsUrl =
      authoritativeUrl ??
      (descriptor.installationId === undefined
        ? null
        : installationSettingsUrl(descriptor.installationId));

    results.push({
      ...descriptor,
      status,
      ...(settingsUrl === null ? {} : { settingsUrl }),
    });
  }
  return results;
}
