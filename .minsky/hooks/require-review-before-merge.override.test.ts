// mt#2989 — REQUEST_CHANGES grant-channel override tests.
//
// Split out of `require-review-before-merge.test.ts` (which is at the
// max-lines ceiling) so the override coverage has room to grow. Covers the
// override branch of `validateReviewContent` (with an injected resolver — no
// real fs/CLI) and the real `makeRequestChangesOverrideResolver` factory (with
// injected store-read / ask-verify / consume / clock).

import { describe, expect, it } from "bun:test";
import {
  EXPECTED_REVIEWER_LOGIN,
  PROVENANCE_MARKER_START,
  PROVENANCE_MARKER_END,
  validateReviewContent,
  makeRequestChangesOverrideResolver,
  type ReviewProvenance,
} from "./require-review-before-merge";
import type { GuardGrant, GuardGrantStoreReadResult } from "./guard-grant-store";
import type { AskVerificationResult } from "./ask-verification";

const OVERRIDE_HEAD = "abc1234567890";

const VALID_PROVENANCE: ReviewProvenance = {
  specVerification: [{ criterion: "SC1: test", status: "Met", evidence: "Found in foo.ts" }],
  docImpact: { kind: "no-update-needed", evidence: "Internal refactor" },
  findings: { blocking: 0, nonBlocking: 1 },
  conclusion: { event: "APPROVE", summary: "Looks good" },
  adoptionSweep: null,
};

function makeProvenanceComment(p: ReviewProvenance): string {
  return `${PROVENANCE_MARKER_START}${JSON.stringify(p)}${PROVENANCE_MARKER_END}`;
}

function makeReview(body: string, commit_id = OVERRIDE_HEAD) {
  return {
    body,
    commit_id,
    submitted_at: "2026-05-23T12:00:00Z",
    user_login: EXPECTED_REVIEWER_LOGIN,
  };
}

function reqChangesReviews() {
  const reqChanges = {
    ...VALID_PROVENANCE,
    conclusion: { event: "REQUEST_CHANGES", summary: "Fix the bug" },
  };
  return [makeReview(`## Review\n${makeProvenanceComment(reqChanges)}`)];
}

describe("validateReviewContent — REQUEST_CHANGES override (mt#2989)", () => {
  it("permits when the resolver authorizes, carrying the audit reason", () => {
    const result = validateReviewContent(reqChangesReviews(), "42", OVERRIDE_HEAD, () => ({
      authorized: true,
      askId: "ask-1",
      auditReason: 'ask=ask-1 grant-reason="disproof"',
    }));
    expect(result.deny).toBe(false);
    expect(result.overrideAuditReason).toContain("ask-1");
    expect(result.overrideAskId).toBe("ask-1");
  });

  it("denies with the fabrication warning when the resolver refuses a present-but-unverified grant", () => {
    const result = validateReviewContent(reqChangesReviews(), "42", OVERRIDE_HEAD, () => ({
      authorized: false,
      fabricationWarning: "that Ask did not verify as operator-approved",
    }));
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("did not verify as operator-approved");
  });

  it("denies and names the grant recovery path when no grant exists", () => {
    const result = validateReviewContent(reqChangesReviews(), "42", OVERRIDE_HEAD, () => ({
      authorized: false,
    }));
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("grant-guard-override.ts");
    expect(result.reason).toContain("authorization.approve");
  });

  it("denies (unchanged) and names the recovery path when NO resolver is supplied", () => {
    const result = validateReviewContent(reqChangesReviews(), "42", OVERRIDE_HEAD);
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("requested changes");
    expect(result.reason).toContain("grant-guard-override.ts");
  });

  it("CONTAINMENT: a STALE review never consults the override resolver", () => {
    // The override is scoped to the REQUEST_CHANGES branch only. A stale review
    // must deny even if a resolver would authorize — so the resolver here THROWS
    // to prove it is never called.
    const reviews = [
      makeReview(`## Review\n${makeProvenanceComment(VALID_PROVENANCE)}`, "old1234567890"),
    ];
    const result = validateReviewContent(reviews, "42", OVERRIDE_HEAD, () => {
      throw new Error("resolver must not be consulted for a stale denial");
    });
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("stale");
  });

  it("CONTAINMENT: an APPROVE review never consults the override resolver", () => {
    const reviews = [makeReview(`## Review\n${makeProvenanceComment(VALID_PROVENANCE)}`)];
    const result = validateReviewContent(reviews, "42", OVERRIDE_HEAD, () => {
      throw new Error("resolver must not be consulted when the review already permits");
    });
    expect(result.deny).toBe(false);
    expect(result.overrideAuditReason).toBeUndefined();
  });
});

describe("makeRequestChangesOverrideResolver (mt#2989)", () => {
  const REPO = "edobry/minsky";
  const HEAD = "deadbeefcafe";
  const NOW = Date.parse("2026-07-23T12:00:00.000Z");
  const REVIEW_GATE = "require-review-before-merge";

  function makeGrant(overrides: Partial<GuardGrant> = {}): GuardGrant {
    return {
      guardName: REVIEW_GATE,
      scope: `${REPO}#42@${HEAD}`,
      issuedAt: new Date(NOW).toISOString(),
      ttlMs: 30 * 60 * 1000,
      reason: "grep-disproven duplicate finding",
      askId: "ask-777",
      ...overrides,
    };
  }
  const okStore = (grants: GuardGrant[]): GuardGrantStoreReadResult => ({ status: "ok", grants });
  const approved: AskVerificationResult = { verdict: "approved", detail: "operator-approved" };

  it("returns not-authorized when headSha is undefined", () => {
    const resolve = makeRequestChangesOverrideResolver(REPO, { readStore: () => okStore([]) });
    expect(resolve({ pr: "42", headSha: undefined })).toEqual({ authorized: false });
  });

  it("returns not-authorized (no warning) when the store errors", () => {
    const resolve = makeRequestChangesOverrideResolver(REPO, {
      readStore: () => ({ status: "error", message: "boom" }),
    });
    expect(resolve({ pr: "42", headSha: HEAD })).toEqual({ authorized: false });
  });

  it("returns not-authorized (no warning) when no grant matches", () => {
    const resolve = makeRequestChangesOverrideResolver(REPO, {
      readStore: () => okStore([]),
      now: () => NOW,
    });
    expect(resolve({ pr: "42", headSha: HEAD })).toEqual({ authorized: false });
  });

  it("refuses loudly when the matching grant carries no askId", () => {
    const resolve = makeRequestChangesOverrideResolver(REPO, {
      readStore: () => okStore([makeGrant({ askId: undefined })]),
      now: () => NOW,
    });
    const result = resolve({ pr: "42", headSha: HEAD });
    expect(result.authorized).toBe(false);
    expect("fabricationWarning" in result && result.fabricationWarning).toContain(
      "no authorization Ask"
    );
  });

  it("refuses loudly when the linked Ask does not verify as operator-approved", () => {
    const resolve = makeRequestChangesOverrideResolver(REPO, {
      readStore: () => okStore([makeGrant()]),
      verify: () => ({ verdict: "not-approved", detail: "responder is agent" }),
      now: () => NOW,
    });
    const result = resolve({ pr: "42", headSha: HEAD });
    expect(result.authorized).toBe(false);
    expect("fabricationWarning" in result && result.fabricationWarning).toContain("ask-777");
  });

  it("authorizes, verifies the grant's askId, and consumes one-shot on an approved Ask", () => {
    let verifiedAsk: string | undefined;
    let consumedCtxScope: string | undefined;
    const resolve = makeRequestChangesOverrideResolver(REPO, {
      readStore: () => okStore([makeGrant()]),
      verify: (askId) => {
        verifiedAsk = askId;
        return approved;
      },
      consume: (_path, ctx) => {
        consumedCtxScope = ctx.scope;
        return makeGrant();
      },
      now: () => NOW,
    });
    const result = resolve({ pr: "42", headSha: HEAD });
    expect(result.authorized).toBe(true);
    expect("askId" in result && result.askId).toBe("ask-777");
    expect("auditReason" in result && result.auditReason).toContain("ask=ask-777");
    expect("auditReason" in result && result.auditReason).toContain("grep-disproven");
    expect(verifiedAsk).toBe("ask-777");
    expect(consumedCtxScope).toBe(`${REPO}#42@${HEAD}`);
  });

  it("does not permit if the grant was consumed (raced) between find and consume", () => {
    const resolve = makeRequestChangesOverrideResolver(REPO, {
      readStore: () => okStore([makeGrant()]),
      verify: () => approved,
      consume: () => null,
      now: () => NOW,
    });
    expect(resolve({ pr: "42", headSha: HEAD })).toEqual({ authorized: false });
  });
});
