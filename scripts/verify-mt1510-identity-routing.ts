#!/usr/bin/env bun
/**
 * mt#1510 verification smoke script — live identity routing on a real PR.
 *
 * Verifies that the new `identity` parameter on `session_pr_review_submit`
 * actually routes review writes through the correct GitHub App installation,
 * by posting two COMMENT reviews on a target PR and reading back the
 * `user.login` GitHub recorded for each:
 *
 *   Leg 1: COMMENT with default identity (no `identity` arg)
 *          → expects `minsky-ai[bot]` per the COMMENT → implementer mapping.
 *   Leg 2: COMMENT with explicit `identity: "reviewer"`
 *          → expects `minsky-reviewer[bot]` per the override path.
 *
 * Together these cover acceptance tests #1 and #4 from the mt#1510 spec.
 * The remaining acceptance tests are covered by unit tests in
 * `src/domain/repository/github-pr-review.test.ts` (resolveReviewerRole,
 * assertReviewerRoleAvailable) and by typed-error coverage in
 * `src/domain/auth/token-provider.test.ts` (isRoleConfigured).
 *
 * Why a smoke script and not just unit tests: identity routing is enforced
 * server-side by GitHub at review-creation time. No unit test can verify
 * that GitHub actually attributes the review to the matching App — only a
 * live round-trip can. The implement-task §7a "structural change requires
 * verification artifact" rule applies; this is the artifact, modelled on
 * mt#1399 (smoke test for output-tools) and mt#1403 (replay verification).
 *
 * USAGE
 *   MT1510_OWNER=edobry MT1510_REPO=minsky MT1510_PR_NUMBER=999 \
 *     GITHUB_TOKEN=$(gh auth token) \
 *     bun scripts/verify-mt1510-identity-routing.ts
 *
 * ENV (all required for full run; see EXIT CODES for graceful skips)
 *   MT1510_OWNER       Repository owner (e.g. `edobry`)
 *   MT1510_REPO        Repository name  (e.g. `minsky`)
 *   MT1510_PR_NUMBER   PR number to post on. The script posts TWO real
 *                      COMMENT reviews on this PR — pick a PR you don't
 *                      mind seeing two probe comments on (e.g., a closed
 *                      one, or one set up for verification).
 *   GITHUB_TOKEN       User-PAT for the GitHub API listing leg. Without
 *                      it the script falls back to `cfg.github.token` from
 *                      the resolved Minsky configuration.
 *
 * Reads Minsky configuration the same way production code does
 * (`getConfiguration()` + `createTokenProvider(cfg.github, userToken)`),
 * so reviewer-App routing only works when `github.reviewer.serviceAccount`
 * is configured locally — same precondition as the production MCP tool.
 *
 * EXIT CODES
 *   0  Both COMMENTs landed under the expected bot identities.
 *   1  Identity mismatch on at least one review (the failure mode).
 *   2  Skipped — env not set, no user token, or reviewer App not
 *      configured. Treat as inconclusive, NOT a regression.
 */

// tsyringe (used transitively by Minsky's configuration loader) requires
// the reflect-metadata polyfill before any decorated class is touched.
import "reflect-metadata";

import { createTokenProvider } from "@minsky/domain/auth";
import {
  CustomConfigFactory,
  getConfiguration,
  initializeConfiguration,
} from "@minsky/domain/configuration";
import { submitReview } from "@minsky/domain/repository/github-pr-review";
import type { TokenRole } from "@minsky/domain/auth/token-provider";

const OWNER = process.env.MT1510_OWNER;
const REPO = process.env.MT1510_REPO;
const PR_RAW = process.env.MT1510_PR_NUMBER;
const PR = PR_RAW ? Number.parseInt(PR_RAW, 10) : undefined;

if (!OWNER || !REPO || PR === undefined || Number.isNaN(PR)) {
  console.log(
    "SKIP: MT1510_OWNER, MT1510_REPO, and MT1510_PR_NUMBER must all be set " +
      "to run the live identity-routing verification. Skipping (exit 2)."
  );
  process.exit(2);
}

// Mirrors the production bootstrap path used by every other Minsky entry
// point: configuration must be initialized before getConfiguration() can be
// called, otherwise the global ConfigurationProvider is uninitialized and
// throws. See `src/config-setup.ts` for the canonical wiring.
await initializeConfiguration(new CustomConfigFactory(), {
  workingDirectory: process.cwd(),
});

const cfg = getConfiguration();
const userToken = cfg.github?.token ?? process.env.GITHUB_TOKEN;
if (!userToken) {
  console.log(
    "SKIP: no GITHUB_TOKEN env var or cfg.github.token available — needed " +
      "for the readback leg (GET /pulls/N/reviews). Skipping (exit 2)."
  );
  process.exit(2);
}

const tokenProvider = createTokenProvider(cfg.github ?? {}, userToken);

if (!tokenProvider.isRoleConfigured("reviewer")) {
  console.log(
    "SKIP: github.reviewer.serviceAccount is not configured locally. The " +
      "implementer leg of this verification could run, but the reviewer- " +
      "routing leg cannot — and a partial run does not validate mt#1510. " +
      "Configure reviewer.serviceAccount and re-run for full verification. " +
      "Skipping (exit 2)."
  );
  process.exit(2);
}

const repoScope = `${OWNER}/${REPO}`;
const gh = {
  owner: OWNER,
  repo: REPO,
  getToken: (role?: TokenRole) => tokenProvider.getToken(role, repoScope),
  isRoleConfigured: (role: TokenRole) => tokenProvider.isRoleConfigured(role),
};

const ts = new Date().toISOString();
const failures: string[] = [];

console.log(`Posting probe COMMENT on ${OWNER}/${REPO}#${PR} (default identity)...`);
const r1 = await submitReview(gh, PR, {
  body:
    `mt#1510 verification probe — leg 1 / default identity. ` +
    `Expected author: minsky-ai[bot] (implementer App). ` +
    `Posted at ${ts}.`,
  event: "COMMENT",
});

console.log(`Posting probe COMMENT on ${OWNER}/${REPO}#${PR} (identity=reviewer)...`);
const r2 = await submitReview(gh, PR, {
  body:
    `mt#1510 verification probe — leg 2 / explicit identity:"reviewer". ` +
    `Expected author: minsky-reviewer[bot] (reviewer App). ` +
    `Posted at ${ts}.`,
  event: "COMMENT",
  identity: "reviewer",
});

const listResp = await fetch(
  `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${PR}/reviews?per_page=100`,
  {
    headers: {
      Authorization: `Bearer ${userToken}`,
      Accept: "application/vnd.github+json",
    },
  }
);
if (!listResp.ok) {
  console.error(`FAIL: GET /pulls/${PR}/reviews returned ${listResp.status}`);
  process.exit(1);
}
const reviews = (await listResp.json()) as Array<{
  id: number;
  user: { login: string } | null;
}>;

function expectAuthor(reviewId: number, expectedLogin: string, label: string): void {
  const review = reviews.find((r) => r.id === reviewId);
  if (!review) {
    failures.push(`${label}: review ID ${reviewId} not found in /pulls/${PR}/reviews`);
    return;
  }
  const actual = review.user?.login ?? "<null>";
  if (actual !== expectedLogin) {
    failures.push(`${label}: expected ${expectedLogin}, got ${actual} (review ID ${reviewId})`);
    return;
  }
  console.log(`PASS: ${label} → posted by ${actual}`);
}

expectAuthor(r1.reviewId, "minsky-ai[bot]", "Leg 1 (default identity → COMMENT)");
expectAuthor(r2.reviewId, "minsky-reviewer[bot]", "Leg 2 (explicit identity:reviewer)");

if (failures.length > 0) {
  console.error("\nFAIL summary:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("\nALL PASSED — mt#1510 identity routing verified end-to-end.");
process.exit(0);
