/**
 * GitHub token provider for the reviewer service's BACKGROUND schedulers.
 *
 * ## Why this module exists (mt#4435)
 *
 * The reviewer service runs two credential systems in one process, and the
 * background schedulers were reading the one this service does not provision:
 *
 * - The **review path** authenticates with the reviewer App's own credentials —
 *   `MINSKY_REVIEWER_APP_ID` / `MINSKY_REVIEWER_PRIVATE_KEY` /
 *   `MINSKY_REVIEWER_INSTALLATION_ID`, read via `requireEnv` in `config.ts`, so
 *   the service cannot boot without them. That is why reviews post as
 *   `minsky-reviewer[bot]`.
 * - The **schedulers** called `createTokenProvider(cfg.github ?? {}, …)` against
 *   the DOMAIN configuration, whose `github.serviceAccount` is populated from a
 *   different namespace entirely (`MINSKY_APP_ID` /
 *   `MINSKY_APP_PRIVATE_KEY_FILE` / `MINSKY_APP_INSTALLATION_ID`). This service
 *   has no reason to set those, so the provider fell through to
 *   `FallbackTokenProvider("")`, every request went out **unauthenticated**, and
 *   GitHub's 60-requests/hour per-IP budget was exhausted within the hour.
 *
 * The symptom was not a crash. `runWatcher` catches per-watch errors and records
 * them in a counter nobody reads, so a fully rate-limited scheduler logs
 * `poll_complete` every cycle and delivers nothing — 18 rate-limit errors across
 * 41 minutes on 2026-08-22, with no escalation.
 *
 * ## Why the reviewer App, and not the implementer App
 *
 * The accepted decision *"Hybrid read/write split for GitHub operations"*
 * (2026-04-20) makes reads **identity-agnostic**: "any authenticated user can
 * read PRs they have access to." Both schedulers only READ (`getPr`,
 * `listReviews`, `listCheckRuns`), so they need to be authenticated as
 * *someone*, not as anyone in particular.
 *
 * Given that, using this service's OWN App is the correct choice rather than
 * merely the convenient one: *"Position: Identity, Signing, and Provenance in
 * the Agentic Engineering Age"* records that the reviewer "runs as a separate
 * process under its own credentials," and calls that "the load-bearing isolation
 * that makes 'adversarial review'" work. Importing the implementer App's
 * credentials into this process to satisfy a read would erode that isolation for
 * no benefit, and would require provisioning env vars this service does not have.
 *
 * That decision record's Open Question 1 anticipated exactly this situation —
 * "when Minsky runs without Claude Code … the read operations currently on
 * GitHub MCP will need to be internalized. **Trigger to revisit:** when Minsky
 * gets a hosted/headless execution mode" — and the schedulers ARE that
 * internalization. This module is the narrow answer for the reviewer service.
 */

import { GitHubAppTokenProvider, type TokenProvider } from "@minsky/domain/auth";
import type { ReviewerConfig } from "./config";

/**
 * The subset of `ReviewerConfig` needed to authenticate as the reviewer App.
 *
 * Narrowed deliberately so callers and tests can pass a minimal object rather
 * than constructing a whole `ReviewerConfig`.
 */
export type ReviewerGitHubCredentials = Pick<
  ReviewerConfig,
  "appId" | "privateKey" | "installationId"
>;

/**
 * The environment variable backing each reviewer-App credential.
 *
 * Single source of truth so the validator, its error message, and the tests all
 * name the same variables — an operator reading a startup error needs the exact
 * string they will set, and a drifted copy would send them to the wrong one.
 */
export const REVIEWER_CREDENTIAL_ENV_VARS = {
  appId: "MINSKY_REVIEWER_APP_ID",
  privateKey: "MINSKY_REVIEWER_PRIVATE_KEY",
  installationId: "MINSKY_REVIEWER_INSTALLATION_ID",
} as const;

/**
 * Raised when the reviewer App credentials are absent or unusable.
 *
 * This is deliberately a THROW rather than a silent fallback. The defect this
 * module fixes was precisely a silent fallback: an empty token produced
 * unauthenticated requests that looked like a working scheduler until GitHub's
 * per-IP budget ran out. A missing credential must be loud.
 */
export class MissingReviewerCredentialsError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `Reviewer GitHub App credentials are missing or unusable: ${missing.join(", ")}. ` +
        "Background schedulers cannot authenticate to GitHub without them, and " +
        "unauthenticated requests exhaust GitHub's 60-per-hour per-IP budget within " +
        "the hour (mt#4435). Set these on the reviewer service and redeploy."
    );
    this.name = "MissingReviewerCredentialsError";
  }
}

/**
 * Return the names of any reviewer-App credentials that are missing or unusable.
 *
 * Pure function over the config — no I/O, no construction — so the validation
 * rule can be tested directly rather than through the provider it guards.
 *
 * `config.ts` reads all three via `requireEnv` and `parseInt`, so in a booted
 * service they are normally present. Two failure shapes survive that:
 * `parseInt` yields `NaN` for a non-numeric value, and a private key can be
 * present-but-empty. Both would otherwise reach GitHub as a malformed JWT and
 * come back as an opaque 401.
 */
export function findMissingReviewerCredentials(
  config: ReviewerGitHubCredentials
): readonly string[] {
  const missing: string[] = [];

  if (!Number.isInteger(config.appId) || config.appId <= 0) {
    missing.push(REVIEWER_CREDENTIAL_ENV_VARS.appId);
  }
  if (typeof config.privateKey !== "string" || config.privateKey.trim() === "") {
    missing.push(REVIEWER_CREDENTIAL_ENV_VARS.privateKey);
  }
  if (!Number.isInteger(config.installationId) || config.installationId <= 0) {
    missing.push(REVIEWER_CREDENTIAL_ENV_VARS.installationId);
  }

  return missing;
}

/**
 * Build a `TokenProvider` backed by the reviewer service's own GitHub App.
 *
 * Every request made through the returned provider is authenticated as
 * `minsky-reviewer[bot]`, which raises the applicable rate limit from GitHub's
 * unauthenticated 60/hour-per-IP to the App installation's budget.
 *
 * @throws MissingReviewerCredentialsError when any credential is absent or
 *   unusable. Callers should let this surface rather than degrading — a
 *   scheduler that cannot authenticate should say so, not poll uselessly.
 */
export function createReviewerTokenProvider(config: ReviewerGitHubCredentials): TokenProvider {
  const missing = findMissingReviewerCredentials(config);
  if (missing.length > 0) {
    throw new MissingReviewerCredentialsError(missing);
  }

  return new GitHubAppTokenProvider({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: config.installationId,
    // No user-token fallback: this process holds no PAT, and an empty string
    // here is exactly the silent-degradation path mt#4435 removed. Any code
    // reaching for `getUserToken()` on this provider should fail loudly rather
    // than send an unauthenticated request.
    userToken: "",
  });
}
