/**
 * Unit tests for failure-alert.ts (mt#4881).
 *
 * Strategy mirrors boot-recovery.test.ts: a stub DB whose `.select().from()`
 * routes by TABLE IDENTITY (not call order, which would silently pass if the two
 * queries were ever reordered), and whose `.update().set().where()` records the
 * persisted payload so the outcome write can be asserted without decoding
 * drizzle's condition objects.
 *
 * The classifier, the coordinate extractor and the aggregator are pure functions
 * and are tested directly — no DB, no emitter (`testing-standards.mdc` §Testable
 * Design: the decision is a function of its inputs).
 */

import { describe, test, expect, mock } from "bun:test";
import {
  classifyReviewFailure,
  extractPrCoordinates,
  aggregatePriorFailures,
  recordReviewFailure,
  shouldEscalateToOperator,
  SUPPRESSION_WINDOW_MS,
  SYSTEMIC_DISTINCT_PR_THRESHOLD,
  type ReviewFailureClass,
} from "./failure-alert";
import { buildCheckRunPayload } from "./check-run-publisher";
import { submissionFailuresTable } from "./db/schemas/submission-failures-schema";
import type { OperatorIncidentContext, ReviewFailureAlertContext } from "./ask-emitter";

// ---------------------------------------------------------------------------
// Shared literals
//
// Hoisted because `custom/no-magic-string-duplication` flags a repeated literal
// and CI's lint gate is `eslint . --max-warnings=0` — a warning here is a red
// build, not a nit.
// ---------------------------------------------------------------------------

const CLASS_TIMEOUT: ReviewFailureClass = "provider_timeout";
const CLASS_CREDITS: ReviewFailureClass = "provider_credits_exhausted";
// Hoisted by mt#2719 for the same reason as the two above: the escalation tests
// reference both classes as the NEGATIVE side of the operator-actionable split,
// which tipped each literal over the duplication rule.
const CLASS_UNAVAILABLE: ReviewFailureClass = "provider_unavailable";
const CLASS_TOKEN_LIMIT: ReviewFailureClass = "provider_token_limit";
const MSG_TOOLLOOP_TIMEOUT = "Operation timed out after 120000ms: toolloop.retry";
const MSG_SELF_SIGNED = "self signed certificate";
const MSG_NO_CREDITS = "429 You have no credits remaining";
const SUPPRESSED_DUP = "suppressed_duplicate";

// ---------------------------------------------------------------------------
// Stub DB
// ---------------------------------------------------------------------------

interface StubRows {
  /** Rows the circuit-breaker ownership probe should see. */
  circuitRows?: unknown[];
  /** Prior failed_at_reviewer rows the aggregation query should see. */
  priorRows?: Array<{ body: unknown; errorDetails: unknown }>;
}

function makeDb(rows: StubRows = {}) {
  const updates: Array<Record<string, unknown>> = [];

  const db = {
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: () => {
          updates.push(payload);
          return Promise.resolve();
        },
      }),
    }),
    select: () => ({
      from: (table: unknown) => {
        const result =
          table === submissionFailuresTable ? (rows.circuitRows ?? []) : (rows.priorRows ?? []);
        return {
          where: () => {
            const promise = Promise.resolve(result);
            return Object.assign(promise, { limit: () => Promise.resolve(result) });
          },
        };
      },
    }),
  };

  return { db, updates };
}

function makeEmitter() {
  const captured: ReviewFailureAlertContext[] = [];
  const emitReviewFailureAlert = mock((ctx: ReviewFailureAlertContext) => {
    captured.push(ctx);
    return Promise.resolve("created" as const);
  });
  // mt#2719 added a third method to the AskEmitter interface — the operator
  // paging tier. Captured rather than stubbed, because the escalation tests
  // below assert both that it fires when the threshold is crossed and that it
  // does NOT fire for self-healing classes.
  const capturedIncidents: OperatorIncidentContext[] = [];
  const emitOperatorIncidentAlert = mock((ctx: OperatorIncidentContext) => {
    capturedIncidents.push(ctx);
    return Promise.resolve("created" as const);
  });
  return {
    captured,
    capturedIncidents,
    emitReviewFailureAlert,
    emitOperatorIncidentAlert,
    emitter: {
      emitCircuitBreakerAlert: () => Promise.resolve("created" as const),
      emitReviewFailureAlert,
      emitOperatorIncidentAlert,
    },
  };
}

const BASE_CTX = {
  owner: "edobry",
  repo: "minsky",
  prNumber: 1234,
  headSha: "abc123",
  deliveryId: "delivery-current",
  stage: "reviewer",
};

/** A stored webhook row shaped like production's, for the aggregation query. */
function priorRow(prNumber: number, message: string, repo = "minsky") {
  return {
    body: {
      repository: { full_name: `edobry/${repo}` },
      pull_request: { number: prNumber },
    },
    errorDetails: { message, stage: "reviewer" },
  };
}

// ---------------------------------------------------------------------------
// Classification (SC3)
// ---------------------------------------------------------------------------

describe("classifyReviewFailure", () => {
  // Every message below is a VERBATIM production string from the 30-day
  // measurement in mt#4881's spec, not an invented sample.
  const cases: Array<[string, ReviewFailureClass]> = [
    [
      "400 Input tokens exceed the configured limit of 272000 tokens. Your messages resulted in 1234592 tokens. Please reduce the length of the messages.",
      "provider_token_limit",
    ],
    [
      "429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
      CLASS_CREDITS,
    ],
    [
      "No server is currently available to service your request. Sorry about that. Please try resubmitting your request and contact us if the problem persists.",
      "provider_unavailable",
    ],
    [
      "Operation timed out after 120000ms: openai.chat.completions.create.toolloop.retry",
      CLASS_TIMEOUT,
    ],
    [
      "Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.",
      "github_diff_too_large",
    ],
    [
      'Unprocessable Entity: "Variable $comments of type [DraftPullRequestReviewComment] was provided invalid value"',
      "github_submit_rejected",
    ],
    [MSG_SELF_SIGNED, "tls_self_signed"],
    ["The socket connection was closed unexpectedly.", "network_socket_closed"],
  ];

  for (const [message, expected] of cases) {
    test(`classifies ${expected}`, () => {
      expect(classifyReviewFailure(message).errorClass).toBe(expected);
    });
  }

  test("an unrecognized message is classified, not dropped", () => {
    const result = classifyReviewFailure("something nobody has seen before");
    expect(result.errorClass).toBe("unclassified");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  test("an EMPTY message is a real input, not a defect (the mt#2465 class)", () => {
    // 2 of the 143 failed_at_reviewer rows carry an empty message — an octokit
    // HttpError whose `.message` is empty while its stack is present. The alert
    // must still fire, because `outcome` is the signal and the message is
    // best-effort.
    for (const empty of ["", "   ", null, undefined]) {
      expect(classifyReviewFailure(empty).errorClass).toBe("unclassified_empty");
    }
  });

  test("the token-limit rule wins over the timeout rule when both could match", () => {
    // Ordering guard: a provider rejection can also mention a duration, and the
    // specific class is the useful one.
    const message = "400 Input tokens exceed the configured limit; operation timed out after 5ms";
    expect(classifyReviewFailure(message).errorClass).toBe(CLASS_TOKEN_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Coordinate extraction
// ---------------------------------------------------------------------------

describe("extractPrCoordinates", () => {
  test("reads full_name + pull_request.number (the production shape)", () => {
    expect(
      extractPrCoordinates({
        repository: { full_name: "edobry/peezombie.me" },
        pull_request: { number: 2 },
      })
    ).toEqual({ owner: "edobry", repo: "peezombie.me", prNumber: 2 });
  });

  test("reads issue.number for the comment-triggered events", () => {
    // The PR number lives at a DIFFERENT path per event type; a reader that
    // only knows pull_request.number drops every comment-triggered failure.
    expect(
      extractPrCoordinates({
        repository: { full_name: "edobry/minsky" },
        issue: { number: 77 },
      })
    ).toEqual({ owner: "edobry", repo: "minsky", prNumber: 77 });
  });

  test("falls back to owner.login + name when full_name is absent", () => {
    expect(
      extractPrCoordinates({
        repository: { owner: { login: "edobry" }, name: "minsky" },
        pull_request: { number: 42 },
      })
    ).toEqual({ owner: "edobry", repo: "minsky", prNumber: 42 });
  });

  test("returns null rather than a bogus key for unusable payloads", () => {
    expect(extractPrCoordinates(null)).toBeNull();
    expect(extractPrCoordinates({})).toBeNull();
    expect(extractPrCoordinates({ repository: { full_name: "edobry/minsky" } })).toBeNull();
    expect(extractPrCoordinates({ pull_request: { number: 1 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Aggregation (SC4)
// ---------------------------------------------------------------------------

describe("aggregatePriorFailures", () => {
  const current = {
    owner: "edobry",
    repo: "minsky",
    prNumber: 10,
    errorClass: CLASS_TIMEOUT as ReviewFailureClass,
  };

  test("counts only the SAME class on the SAME PR as prior occurrences", () => {
    const result = aggregatePriorFailures(
      [
        { owner: "edobry", repo: "minsky", prNumber: 10, errorClass: CLASS_TIMEOUT },
        // different class, same PR — not a prior occurrence of THIS condition
        { owner: "edobry", repo: "minsky", prNumber: 10, errorClass: CLASS_UNAVAILABLE },
        // same class, different PR — counts toward breadth, not toward this PR
        { owner: "edobry", repo: "minsky", prNumber: 11, errorClass: CLASS_TIMEOUT },
      ],
      current
    );
    expect(result.priorOccurrencesOnPr).toBe(1);
    expect(result.distinctPrsWithClass).toBe(2);
  });

  test("the current PR is counted in the distinct-PR breadth even with no priors", () => {
    const result = aggregatePriorFailures([], current);
    expect(result.priorOccurrencesOnPr).toBe(0);
    expect(result.distinctPrsWithClass).toBe(1);
    expect(result.systemic).toBe(false);
  });

  test("one PR failing many times is NOT systemic", () => {
    // The 2026-09-01 shape: 4 failures, 1 PR, one deterministic cause.
    const priors = Array.from({ length: 3 }, () => ({
      owner: "edobry",
      repo: "minsky",
      prNumber: 10,
      errorClass: CLASS_TIMEOUT as ReviewFailureClass,
    }));
    const result = aggregatePriorFailures(priors, current);
    expect(result.priorOccurrencesOnPr).toBe(3);
    expect(result.distinctPrsWithClass).toBe(1);
    expect(result.systemic).toBe(false);
  });

  test("the same class across the threshold's worth of distinct PRs IS systemic", () => {
    // The 2026-08-17 shape: a repo-wide condition, many PRs.
    const priors = Array.from({ length: SYSTEMIC_DISTINCT_PR_THRESHOLD - 1 }, (_, i) => ({
      owner: "edobry",
      repo: "minsky",
      prNumber: 100 + i,
      errorClass: CLASS_TIMEOUT as ReviewFailureClass,
    }));
    const result = aggregatePriorFailures(priors, current);
    expect(result.distinctPrsWithClass).toBe(SYSTEMIC_DISTINCT_PR_THRESHOLD);
    expect(result.systemic).toBe(true);
  });

  test("alreadySystemic is false on the failure that TIPS the condition over", () => {
    // The tipping failure must still alert — it is the one carrying the
    // "this is repo-wide" signal to the operator.
    const priors = Array.from({ length: SYSTEMIC_DISTINCT_PR_THRESHOLD - 1 }, (_, i) => ({
      owner: "edobry",
      repo: "minsky",
      prNumber: 200 + i,
      errorClass: CLASS_TIMEOUT,
    }));
    const result = aggregatePriorFailures(priors, current);
    expect(result.systemic).toBe(true);
    expect(result.alreadySystemic).toBe(false);
  });

  test("alreadySystemic is true once the PRIORS alone cross the threshold", () => {
    const priors = Array.from({ length: SYSTEMIC_DISTINCT_PR_THRESHOLD }, (_, i) => ({
      owner: "edobry",
      repo: "minsky",
      prNumber: 300 + i,
      errorClass: CLASS_TIMEOUT,
    }));
    expect(aggregatePriorFailures(priors, current).alreadySystemic).toBe(true);
  });

  test("distinct PRs are keyed per repo, so the same number in two repos is two PRs", () => {
    const result = aggregatePriorFailures(
      [{ owner: "edobry", repo: "peezombie.me", prNumber: 10, errorClass: CLASS_TIMEOUT }],
      current
    );
    expect(result.distinctPrsWithClass).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The seam (SC1, SC2, SC3, SC8)
// ---------------------------------------------------------------------------

describe("recordReviewFailure", () => {
  test("AT1: a pre-submit failure creates an ask naming the repo, PR, and error class", async () => {
    const { db, updates } = makeDb();
    const { emitter, captured } = makeEmitter();

    const outcome = await recordReviewFailure(
      db as never,
      {
        ...BASE_CTX,
        message: "429 You have no credits remaining. Add credits to continue using the API",
      },
      { askEmitter: emitter }
    );

    expect(outcome).toBe("emitted");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      owner: "edobry",
      repo: "minsky",
      prNumber: 1234,
      headSha: "abc123",
      errorClass: CLASS_CREDITS,
      stage: "reviewer",
    });

    // The outcome row is still written — this ADDS a path and removes none.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ outcome: "failed_at_reviewer" });
  });

  test("AT3: a burst on one (PR, class) produces exactly one ask", async () => {
    const { emitter, captured } = makeEmitter();

    // Attempt 1: nothing prior in the window → emits.
    const first = await recordReviewFailure(
      makeDb().db as never,
      { ...BASE_CTX, message: MSG_TOOLLOOP_TIMEOUT },
      { askEmitter: emitter }
    );
    expect(first).toBe("emitted");

    // Attempts 2..20: the earlier failures are now in the window → suppressed.
    const priorRows = Array.from({ length: 19 }, () => priorRow(1234, MSG_TOOLLOOP_TIMEOUT));
    for (let attempt = 2; attempt <= 20; attempt++) {
      const outcome = await recordReviewFailure(
        makeDb({ priorRows }).db as never,
        { ...BASE_CTX, message: MSG_TOOLLOOP_TIMEOUT },
        { askEmitter: emitter }
      );
      expect(outcome).toBe(SUPPRESSED_DUP);
    }

    // 20 failures, 1 ask.
    expect(captured).toHaveLength(1);
  });

  test("a DIFFERENT error class on the same PR is not suppressed by the first", async () => {
    // Dedup keys on the class, not just the PR — otherwise a second, unrelated
    // cause on the same PR would be silently swallowed by the first one's ask.
    const { emitter, captured } = makeEmitter();
    const priorRows = [priorRow(1234, MSG_SELF_SIGNED)];

    const outcome = await recordReviewFailure(
      makeDb({ priorRows }).db as never,
      { ...BASE_CTX, message: MSG_NO_CREDITS },
      { askEmitter: emitter }
    );

    expect(outcome).toBe("emitted");
    expect(captured[0]?.errorClass).toBe(CLASS_CREDITS);
  });

  test("AT4: 5 distinct PRs with one class read as a systemic condition, not 5 one-offs", async () => {
    // Fired sequentially, the way production sees them, with each failure's
    // predecessors as its priors.
    const { emitter, captured } = makeEmitter();
    const message = MSG_NO_CREDITS;
    const outcomes: string[] = [];

    for (let i = 0; i < 5; i++) {
      const priorRows = Array.from({ length: i }, (_, j) => priorRow(600 + j, message));
      outcomes.push(
        await recordReviewFailure(
          makeDb({ priorRows }).db as never,
          { ...BASE_CTX, prNumber: 600 + i, message },
          { askEmitter: emitter }
        )
      );
    }

    // 5 failures across 5 PRs produce 3 asks, not 5: the first two look
    // isolated, the third names the condition repo-wide, and the rest are
    // suppressed as already-systemic.
    expect(outcomes).toEqual(["emitted", "emitted", "emitted", SUPPRESSED_DUP, SUPPRESSED_DUP]);
    expect(captured).toHaveLength(3);
    expect(captured[2]?.systemic).toBe(true);
    expect(captured[2]?.distinctPrsWithClass).toBe(SYSTEMIC_DISTINCT_PR_THRESHOLD);
    // ...and the earlier two did NOT overclaim.
    expect(captured[0]?.systemic).toBe(false);
    expect(captured[1]?.systemic).toBe(false);
  });

  test("an ALREADY-systemic condition is suppressed even on a brand-new PR", async () => {
    // The reason the dedup key is adaptive. A repo-wide outage hits each PR
    // once, so a per-PR key dedups nothing: replaying the real 30-day corpus
    // left 60 asks for 88 failures. One ask already told the operator the
    // condition is repo-wide; the rest are noise on top of it.
    const { emitter, captured } = makeEmitter();
    const message = MSG_NO_CREDITS;
    const priorRows = [10, 11, 12, 13].map((n) => priorRow(n, message));

    const outcome = await recordReviewFailure(
      makeDb({ priorRows }).db as never,
      { ...BASE_CTX, prNumber: 999, message },
      { askEmitter: emitter }
    );

    expect(outcome).toBe(SUPPRESSED_DUP);
    expect(captured).toHaveLength(0);
  });

  test("the failure that TIPS a condition into systemic still alerts, flagged systemic", async () => {
    const { emitter, captured } = makeEmitter();
    const message = MSG_NO_CREDITS;
    // Threshold - 1 distinct prior PRs; this failure is the one that crosses it.
    const priorRows = Array.from({ length: SYSTEMIC_DISTINCT_PR_THRESHOLD - 1 }, (_, i) =>
      priorRow(500 + i, message)
    );

    const outcome = await recordReviewFailure(
      makeDb({ priorRows }).db as never,
      { ...BASE_CTX, prNumber: 999, message },
      { askEmitter: emitter }
    );

    expect(outcome).toBe("emitted");
    expect(captured[0]?.systemic).toBe(true);
  });

  test("AT5/SC8: a failure already owned by the circuit breaker does NOT double-alert", async () => {
    // A submit-path failure writes BOTH a failed_at_reviewer row and a
    // reviewer_submission_failures row. The circuit breaker (mt#2350) alerts on
    // it, so this path must not alert again — 9 of the measured 88 are this class.
    const { emitter, captured } = makeEmitter();
    const { db, updates } = makeDb({ circuitRows: [{ id: "existing-circuit-row" }] });

    const outcome = await recordReviewFailure(
      db as never,
      { ...BASE_CTX, message: 'Unprocessable Entity: "Variable $comments ... "' },
      { askEmitter: emitter }
    );

    expect(outcome).toBe("suppressed_circuit_breaker");
    expect(captured).toHaveLength(0);
    // The outcome row is STILL written — suppression is about the alert only.
    expect(updates).toHaveLength(1);
  });

  test("AT6: a boot_recovery-stage failure alerts on the same seam, carrying its stage", async () => {
    // 33 of the measured 88 take this path; a seam covering only server.ts would
    // leave ~38% of the class dark.
    const { emitter, captured } = makeEmitter();

    await recordReviewFailure(
      makeDb().db as never,
      { ...BASE_CTX, stage: "boot_recovery", message: MSG_SELF_SIGNED },
      { askEmitter: emitter }
    );

    expect(captured[0]).toMatchObject({
      stage: "boot_recovery",
      errorClass: "tls_self_signed",
    });
  });

  test("SC3: an empty message still alerts, classified as the empty class", async () => {
    const { emitter, captured } = makeEmitter();

    const outcome = await recordReviewFailure(
      makeDb().db as never,
      { ...BASE_CTX, message: "" },
      { askEmitter: emitter }
    );

    expect(outcome).toBe("emitted");
    expect(captured[0]?.errorClass).toBe("unclassified_empty");
  });

  test("with no emitter wired, the outcome row is still written and nothing throws", async () => {
    const { db, updates } = makeDb();
    const outcome = await recordReviewFailure(db as never, { ...BASE_CTX, message: "boom" }, {});
    expect(outcome).toBe("no_emitter");
    expect(updates).toHaveLength(1);
  });

  test("fail-open: an emitter that throws does not propagate", async () => {
    const { db, updates } = makeDb();
    const emitter = {
      emitCircuitBreakerAlert: () => Promise.resolve("created" as const),
      emitReviewFailureAlert: () => Promise.reject(new Error("asks substrate down")),
      emitOperatorIncidentAlert: () => Promise.resolve("created" as const),
    };

    const outcome = await recordReviewFailure(
      db as never,
      { ...BASE_CTX, message: "boom" },
      { askEmitter: emitter }
    );

    expect(outcome).toBe("failed");
    // The review path is unaffected: the outcome row still landed.
    expect(updates).toHaveLength(1);
  });

  test("fail-open: a DB that throws on the aggregation query does not propagate", async () => {
    const db = {
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      select: () => ({
        from: () => ({
          where: () => {
            throw new Error("connection lost");
          },
        }),
      }),
    };
    const { emitter } = makeEmitter();

    const outcome = await recordReviewFailure(
      db as never,
      { ...BASE_CTX, message: "boom" },
      { askEmitter: emitter }
    );

    expect(outcome).toBe("failed");
  });

  test("the suppression window is bounded, not unbounded", () => {
    // Guard against a future edit turning the window into "forever", which would
    // silently stop alerting on a recurring condition after its first ask.
    expect(SUPPRESSION_WINDOW_MS).toBeGreaterThan(0);
    expect(SUPPRESSION_WINDOW_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// SC7: the check-run payload on the thrown path
// ---------------------------------------------------------------------------

describe("buildCheckRunPayload with an unknown round (mt#4881 SC7)", () => {
  test("a thrown failure yields conclusion=failure with no fabricated round", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: { roundNumber: null, blockingCount: 0 },
      failureSummary: "400 Input tokens exceed the configured limit",
    });

    expect(payload.conclusion).toBe("failure");
    expect(payload.output.summary).toBe(
      "Reviewer failure: 400 Input tokens exceed the configured limit"
    );
    expect(payload.output.title).toBe("minsky-reviewer: error");
    // The point of `null`: no invented round number reaches the operator.
    expect(payload.output.summary).not.toContain("round");
    expect(payload.output.title).not.toContain("round");
  });

  test("a numeric round renders byte-identically to the pre-change output", () => {
    // Regression guard: the null case must not have changed the existing path.
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: { roundNumber: 3, blockingCount: 0 },
      failureSummary: "empty output",
    });

    expect(payload.output.summary).toBe("Reviewer failure (round 3): empty output");
    expect(payload.output.title).toBe("minsky-reviewer: error (round 3)");
  });

  test("a numeric round still renders the non-failure summaries unchanged", () => {
    expect(
      buildCheckRunPayload({
        toolCalls: [],
        convergenceState: { roundNumber: 2, blockingCount: 0 },
      }).output.summary
    ).toBe("Round 2: no blocking findings — approved.");

    expect(
      buildCheckRunPayload({
        toolCalls: [],
        convergenceState: { roundNumber: 2, blockingCount: 1 },
      }).output.summary
    ).toBe("Round 2: 1 blocking finding remain.");
  });
});

// ---------------------------------------------------------------------------
// The operator escalation tier (mt#2719)
// ---------------------------------------------------------------------------

const MSG_NO_CAPACITY = "No server is currently available to handle the request";

describe("shouldEscalateToOperator (mt#2719)", () => {
  test("fires only on the threshold crossing, so one episode pages once", () => {
    // priorOccurrencesOfClass counts everything BEFORE this failure.
    expect(shouldEscalateToOperator(CLASS_CREDITS, 0)).toBe(false);
    expect(shouldEscalateToOperator(CLASS_CREDITS, 1)).toBe(false);
    expect(shouldEscalateToOperator(CLASS_CREDITS, 2)).toBe(true);
    // 4th and beyond: already escalated, do not page again.
    expect(shouldEscalateToOperator(CLASS_CREDITS, 3)).toBe(false);
    expect(shouldEscalateToOperator(CLASS_CREDITS, 9)).toBe(false);
  });

  test("never fires for self-healing classes, however many there are", () => {
    // The whole discriminator: these recover without a human, so paging on them
    // would spend attention on nothing and burn the 3-per-24h page ceiling.
    for (const priors of [2, 3, 20]) {
      expect(shouldEscalateToOperator(CLASS_UNAVAILABLE, priors)).toBe(false);
      expect(shouldEscalateToOperator(CLASS_TIMEOUT, priors)).toBe(false);
    }
  });

  test("never fires for single-PR deterministic classes owned elsewhere", () => {
    expect(shouldEscalateToOperator("github_diff_too_large", 2)).toBe(false);
    expect(shouldEscalateToOperator(CLASS_TOKEN_LIMIT, 2)).toBe(false);
  });
});

describe("recordReviewFailure operator escalation (mt#2719)", () => {
  test("the third credits failure in the window pages, carrying the billing URL", async () => {
    const { emitter, capturedIncidents } = makeEmitter();
    const priorRows = [priorRow(10, MSG_NO_CREDITS), priorRow(11, MSG_NO_CREDITS)];

    await recordReviewFailure(
      makeDb({ priorRows }).db as never,
      { ...BASE_CTX, prNumber: 12, message: MSG_NO_CREDITS },
      { askEmitter: emitter, provider: "openai" }
    );

    expect(capturedIncidents).toHaveLength(1);
    const incident = capturedIncidents[0];
    expect(incident?.source).toBe("provider");
    expect(incident?.remediationUrl).toContain("platform.openai.com");
    if (incident?.source === "provider") {
      expect(incident.errorClass).toBe(CLASS_CREDITS);
      expect(incident.occurrencesInWindow).toBe(3);
    }
  });

  test("two failures is not yet sustained — no page", async () => {
    const { emitter, capturedIncidents } = makeEmitter();
    const priorRows = [priorRow(10, MSG_NO_CREDITS)];

    await recordReviewFailure(
      makeDb({ priorRows }).db as never,
      { ...BASE_CTX, prNumber: 11, message: MSG_NO_CREDITS },
      { askEmitter: emitter, provider: "openai" }
    );

    expect(capturedIncidents).toHaveLength(0);
  });

  test("a sustained self-healing outage never pages, however long it runs", async () => {
    const { emitter, capturedIncidents } = makeEmitter();
    const priorRows = Array.from({ length: 8 }, (_, i) => priorRow(20 + i, MSG_NO_CAPACITY));

    await recordReviewFailure(
      makeDb({ priorRows }).db as never,
      { ...BASE_CTX, prNumber: 99, message: MSG_NO_CAPACITY },
      { askEmitter: emitter, provider: "openai" }
    );

    expect(capturedIncidents).toHaveLength(0);
  });

  test("escalates even when the ordinary alert is suppressed as a duplicate", async () => {
    // The case the escalation gate exists for: an outage that keeps failing the
    // SAME PR. mt#4881's per-PR suppression correctly silences the inbox ask
    // from occurrence 2, so if the escalation lived after it, a single-PR outage
    // could never reach the count that proves it sustained.
    const { emitter, capturedIncidents } = makeEmitter();
    const priorRows = [priorRow(1234, MSG_NO_CREDITS), priorRow(1234, MSG_NO_CREDITS)];

    const outcome = await recordReviewFailure(
      makeDb({ priorRows }).db as never,
      { ...BASE_CTX, prNumber: 1234, message: MSG_NO_CREDITS },
      { askEmitter: emitter, provider: "openai" }
    );

    expect(outcome).toBe(SUPPRESSED_DUP);
    expect(capturedIncidents).toHaveLength(1);
  });

  test("an unknown provider yields guidance, not another vendor's billing page", async () => {
    const { emitter, capturedIncidents } = makeEmitter();
    const priorRows = [priorRow(10, MSG_NO_CREDITS), priorRow(11, MSG_NO_CREDITS)];

    await recordReviewFailure(
      makeDb({ priorRows }).db as never,
      { ...BASE_CTX, prNumber: 12, message: MSG_NO_CREDITS },
      { askEmitter: emitter, provider: "some-new-provider" }
    );

    expect(capturedIncidents[0]?.remediationUrl).not.toContain("http");
  });

  test("an escalation failure does not stop the ordinary alert path", async () => {
    const { captured } = makeEmitter();
    const emitter = {
      emitCircuitBreakerAlert: () => Promise.resolve("created" as const),
      emitReviewFailureAlert: mock((ctx: ReviewFailureAlertContext) => {
        captured.push(ctx);
        return Promise.resolve("created" as const);
      }),
      emitOperatorIncidentAlert: () => Promise.reject(new Error("paging substrate down")),
    };
    const priorRows = [priorRow(10, MSG_NO_CREDITS), priorRow(11, MSG_NO_CREDITS)];

    const outcome = await recordReviewFailure(
      makeDb({ priorRows }).db as never,
      { ...BASE_CTX, prNumber: 12, message: MSG_NO_CREDITS },
      { askEmitter: emitter, provider: "openai" }
    );

    // The inbox ask still went out even though paging blew up.
    expect(outcome).toBe("emitted");
    expect(captured).toHaveLength(1);
  });
});
