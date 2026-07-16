/**
 * Tests for the refutation-aware re-assertion recovery wiring (mt#2836) at
 * the applyRecoveryAndCompose seam.
 *
 * The recovery logic itself (identity matching, refutation detection,
 * engagement scoring) is unit-tested exhaustively in
 * refutation-recovery.test.ts, including the mt#2789/PR#1942 GREATEST
 * calibration fixture. These tests cover only the OPTIONS PLUMBING at this
 * seam — that the flag actually gates the pass, that the results flow
 * through to the composed output, and that a downgrade crossing BLOCKING
 * to zero reconciles the conclude_review event independently of the
 * mt#1496 monotonicity-recovery flag.
 */

import { describe, test, expect } from "bun:test";
import { applyRecoveryAndCompose } from "./recovery-compose";
import type { ReviewToolCall } from "./output-tools";

function conclude(
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  summary?: string
): ReviewToolCall {
  return { name: "conclude_review", args: { event, summary: summary ?? `${event} summary` } };
}

describe("refutation-aware re-assertion recovery wiring (mt#2836)", () => {
  const REFUTATION_FILE = "src/queries.ts";
  const REFUTATION_LINE = 40;
  const REFUTATION_SUMMARY = "Postgres GREATEST returns NULL when any argument is NULL";
  const GREATEST_REASSERTION_DETAILS = "GREATEST returns NULL when a NULL argument is passed.";

  function greatestFinding(details: string): ReviewToolCall {
    return {
      name: "submit_finding",
      args: {
        severity: "BLOCKING",
        file: REFUTATION_FILE,
        line: REFUTATION_LINE,
        summary: REFUTATION_SUMMARY,
        details,
      },
    };
  }

  function greatestBody(details: string): string {
    return [
      "## Findings",
      "",
      `- [BLOCKING] ${REFUTATION_FILE}:${REFUTATION_LINE} — ${REFUTATION_SUMMARY}`,
      `  ${details}`,
    ].join("\n");
  }

  const PRIOR_BODIES = [
    greatestBody("GREATEST returns NULL per MySQL semantics."),
    greatestBody("Still returns NULL on a NULL argument."),
  ];
  const REFUTING_COMMIT =
    "Ran a query against a live Postgres 17 instance and confirmed GREATEST ignores NULL " +
    "arguments entirely, per the Postgres manual — this is not MySQL semantics. Added the " +
    "empirical transcript as a code comment.";

  test("disabled: refutationDowngrades is empty even with 2+ matching priors and a refutation", () => {
    const toolCalls: ReviewToolCall[] = [
      greatestFinding(GREATEST_REASSERTION_DETAILS),
      conclude("REQUEST_CHANGES"),
    ];
    const result = applyRecoveryAndCompose(toolCalls, [], "", false, {
      recoveryEnabled: false,
      refutationRecoveryEnabled: false,
      priorReviewBodiesForRefutation: PRIOR_BODIES,
      commitMessagesForRefutation: [REFUTING_COMMIT],
    });
    expect(result.refutationDowngrades).toHaveLength(0);
    expect(result.postRecoveryBlockingCount).toBe(1);
  });

  test("enabled: downgrades a >=2nd re-assertion with an unaddressed refutation and reconciles the event", () => {
    const toolCalls: ReviewToolCall[] = [
      greatestFinding(GREATEST_REASSERTION_DETAILS),
      conclude("REQUEST_CHANGES"),
    ];
    const result = applyRecoveryAndCompose(toolCalls, [], "", false, {
      recoveryEnabled: false,
      refutationRecoveryEnabled: true,
      priorReviewBodiesForRefutation: PRIOR_BODIES,
      commitMessagesForRefutation: [REFUTING_COMMIT],
    });
    expect(result.refutationDowngrades).toHaveLength(1);
    expect(result.refutationDowngrades[0]?.reassertionCount).toBe(2);
    expect(result.postRecoveryBlockingCount).toBe(0);
    // Step 3 (crossed-zero reconciliation) is gated on recoveryEnabled
    // (mt#1496), not refutationRecoveryEnabled — the refutation-recovery
    // step in applyRecoveryAndCompose runs its OWN crossed-zero check so a
    // REQUEST_CHANGES conclude_review call doesn't survive composition with
    // zero BLOCKING findings backing it. Pinned to COMMENT (not just
    // "not REQUEST_CHANGES") per the R1-review adjudication (mt#2836):
    // demote-only is the deliberate, codebase-wide convention (mirrors
    // Step 3's mt#1496 reconciliation, which also never promotes to
    // APPROVE) — see the reconciliation site's comment in recovery-compose.ts
    // for the full rationale, including why this does not "risk a silent
    // COMMENT verdict" (the merge gate only denies on REQUEST_CHANGES).
    expect(result.composed.event).toBe("COMMENT");
    expect(result.reconcileApplied).toBe(true);
  });

  test("enabled but fewer than 2 prior review bodies: no-op", () => {
    const toolCalls: ReviewToolCall[] = [greatestFinding("Still broken.")];
    const result = applyRecoveryAndCompose(toolCalls, [], "", false, {
      recoveryEnabled: false,
      refutationRecoveryEnabled: true,
      priorReviewBodiesForRefutation: [PRIOR_BODIES[0] ?? ""],
      commitMessagesForRefutation: [REFUTING_COMMIT],
    });
    expect(result.refutationDowngrades).toHaveLength(0);
  });

  test("enabled with no commit messages: never downgrades (no author response in context)", () => {
    const toolCalls: ReviewToolCall[] = [greatestFinding("Still broken.")];
    const result = applyRecoveryAndCompose(toolCalls, [], "", false, {
      recoveryEnabled: false,
      refutationRecoveryEnabled: true,
      priorReviewBodiesForRefutation: PRIOR_BODIES,
      commitMessagesForRefutation: [],
    });
    expect(result.refutationDowngrades).toHaveLength(0);
    expect(result.postRecoveryBlockingCount).toBe(1);
  });

  test("a genuinely-unaddressed BLOCKING finding still blocks end-to-end through composition", () => {
    const toolCalls: ReviewToolCall[] = [
      greatestFinding(GREATEST_REASSERTION_DETAILS),
      conclude("REQUEST_CHANGES"),
    ];
    const unrelatedCommits = ["chore: bump eslint", "docs: fix typo"];
    const result = applyRecoveryAndCompose(toolCalls, [], "", false, {
      recoveryEnabled: false,
      refutationRecoveryEnabled: true,
      priorReviewBodiesForRefutation: PRIOR_BODIES,
      commitMessagesForRefutation: unrelatedCommits,
    });
    expect(result.refutationDowngrades).toHaveLength(0);
    expect(result.postRecoveryBlockingCount).toBe(1);
    expect(result.composed.event).toBe("REQUEST_CHANGES");
  });
});
