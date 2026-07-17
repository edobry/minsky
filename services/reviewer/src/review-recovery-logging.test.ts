import { describe, expect, test } from "bun:test";
import { logRecoveryOutcomes, type LogRecoveryOutcomesInput } from "./review-recovery-logging";
import type { ComposeWithRecoveryResult } from "./recovery-compose";
import type { ReviewOutput } from "./providers";
import { captureConsoleLogs } from "./test-helpers/log-capture";

function baseRecoveryResult(
  overrides: Partial<ComposeWithRecoveryResult> = {}
): ComposeWithRecoveryResult {
  return {
    toolCalls: [],
    composed: {
      body: "body",
      event: "REQUEST_CHANGES",
      threadResolves: [],
      inlineComments: [],
      reconciled: false,
    },
    downgrades: [],
    originalBlockingCount: 0,
    postRecoveryBlockingCount: 1,
    synthesizedBlockingCount: 1,
    reconcileApplied: false,
    convergenceDowngrades: [],
    diffScopeBoundedDowngrades: [],
    refutationDowngrades: [],
    emptyFindingsRecovery: { toolCalls: [], applied: false },
    ...overrides,
  };
}

function baseOutput(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    text: "",
    provider: "openai",
    model: "gpt-5",
    toolCalls: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<LogRecoveryOutcomesInput> = {}): LogRecoveryOutcomesInput {
  return {
    recoveryResult: baseRecoveryResult(),
    output: baseOutput(),
    owner: "edobry",
    repo: "minsky",
    prNumber: 1234,
    headSha: "abc123",
    iterationIndex: 1,
    monotonicityRecoveryEnabled: false,
    compositionConvergenceEnabled: false,
    diffScopeBoundedEnabled: false,
    refutationRecoveryEnabled: false,
    priorReviewsPresent: false,
    filesInScope: 0,
    ...overrides,
  };
}

async function withCapturedLogs<T>(fn: () => T): Promise<{ events: unknown[]; result: T }> {
  const events: unknown[] = [];
  const { logs, restore } = captureConsoleLogs();
  try {
    const result = fn();
    for (const line of logs) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip non-JSON lines
      }
    }
    return { events, result };
  } finally {
    restore();
  }
}

const SUMMARY_EVENT = "reviewer.empty_findings_recovery_summary";

function findEvent(events: unknown[], name: string): Record<string, unknown> | undefined {
  return events.find(
    (e) => typeof e === "object" && e !== null && (e as Record<string, unknown>)["event"] === name
  ) as Record<string, unknown> | undefined;
}

describe("logRecoveryOutcomes — mt#2828 budgeted summary signal", () => {
  test("emits reviewer.empty_findings_recovery_summary unconditionally, even when recovery did not fire", async () => {
    const input = baseInput({
      recoveryResult: baseRecoveryResult({
        emptyFindingsRecovery: { toolCalls: [], applied: false },
      }),
    });
    const { events } = await withCapturedLogs(() => logRecoveryOutcomes(input));

    const summary = findEvent(events, SUMMARY_EVENT);
    expect(summary).toBeDefined();
    expect(summary?.["applied"]).toBe(false);
    expect(summary?.["prUrl"]).toBe("https://github.com/edobry/minsky/pull/1234");
    expect(summary?.["sha"]).toBe("abc123");
    expect(summary?.["iterationIndex"]).toBe(1);
    expect(summary?.["budgetThresholdPct"]).toBe(10);
    expect(summary?.["budgetWindowDays"]).toBe(7);
  });

  test("reports applied=true and the guard's rejection stats when the recovery pass fired", async () => {
    const input = baseInput({
      recoveryResult: baseRecoveryResult({
        emptyFindingsRecovery: {
          toolCalls: [],
          applied: true,
          synthesizedFinding: {
            severity: "BLOCKING",
            file: "(review summary)",
            line: 1,
            summary: "s",
            details: "d",
          },
        },
      }),
      output: baseOutput({
        concludeReviewGuard: { rejectionCount: 2, boundExhausted: true },
      }),
    });
    const { events } = await withCapturedLogs(() => logRecoveryOutcomes(input));

    const summary = findEvent(events, SUMMARY_EVENT);
    expect(summary?.["applied"]).toBe(true);
    expect(summary?.["concludeReviewGuardRejectionCount"]).toBe(2);
    expect(summary?.["concludeReviewGuardBoundExhausted"]).toBe(true);
  });

  test("defaults guard fields to 0/false when concludeReviewGuard is absent (non-OpenAI / no-tools path)", async () => {
    const input = baseInput({
      output: baseOutput({ concludeReviewGuard: undefined }),
    });
    const { events } = await withCapturedLogs(() => logRecoveryOutcomes(input));

    const summary = findEvent(events, SUMMARY_EVENT);
    expect(summary?.["concludeReviewGuardRejectionCount"]).toBe(0);
    expect(summary?.["concludeReviewGuardBoundExhausted"]).toBe(false);
  });

  test("still emits the per-fire reviewer.empty_findings_recovery event when applied=true (pre-existing behavior preserved)", async () => {
    const input = baseInput({
      recoveryResult: baseRecoveryResult({
        emptyFindingsRecovery: {
          toolCalls: [],
          applied: true,
          synthesizedFinding: {
            severity: "BLOCKING",
            file: "(review summary)",
            line: 1,
            summary: "synth summary",
            details: "d",
          },
        },
      }),
    });
    const { events } = await withCapturedLogs(() => logRecoveryOutcomes(input));

    const fire = findEvent(events, "reviewer.empty_findings_recovery");
    expect(fire).toBeDefined();
    expect(fire?.["synthesizedSummary"]).toBe("synth summary");
  });
});

const REFUTATION_SUMMARY_EVENT = "reviewer.refutation_recovery_summary";

describe("logRecoveryOutcomes — refutation-recovery logging (mt#2836)", () => {
  test("emits nothing when refutationRecoveryEnabled is false", async () => {
    const input = baseInput({ refutationRecoveryEnabled: false });
    const { events } = await withCapturedLogs(() => logRecoveryOutcomes(input));

    expect(findEvent(events, REFUTATION_SUMMARY_EVENT)).toBeUndefined();
    expect(findEvent(events, "reviewer.refutation_recovery_downgrade")).toBeUndefined();
  });

  test("emits the summary event with downgradeApplied=false when enabled but no downgrades fired", async () => {
    const input = baseInput({
      refutationRecoveryEnabled: true,
      recoveryResult: baseRecoveryResult({ refutationDowngrades: [] }),
    });
    const { events } = await withCapturedLogs(() => logRecoveryOutcomes(input));

    const summary = findEvent(events, REFUTATION_SUMMARY_EVENT);
    expect(summary).toBeDefined();
    expect(summary?.["downgradeApplied"]).toBe(false);
    expect(summary?.["downgradeCount"]).toBe(0);
  });

  test("emits a per-finding downgrade event plus the summary when a downgrade fired", async () => {
    const input = baseInput({
      refutationRecoveryEnabled: true,
      recoveryResult: baseRecoveryResult({
        refutationDowngrades: [
          {
            file: "src/queries.ts",
            line: 40,
            fromSeverity: "BLOCKING",
            toSeverity: "NON-BLOCKING",
            reassertionCount: 2,
            totalRounds: 3,
            refutationExcerpt: "PG17 transcript",
            reason: "refutation-recovery: unaddressed after 3 rounds",
          },
        ],
      }),
    });
    const { events } = await withCapturedLogs(() => logRecoveryOutcomes(input));

    const fire = findEvent(events, "reviewer.refutation_recovery_downgrade");
    expect(fire).toBeDefined();
    expect(fire?.["file"]).toBe("src/queries.ts");
    expect(fire?.["reassertionCount"]).toBe(2);
    expect(fire?.["totalRounds"]).toBe(3);

    const summary = findEvent(events, REFUTATION_SUMMARY_EVENT);
    expect(summary?.["downgradeApplied"]).toBe(true);
    expect(summary?.["downgradeCount"]).toBe(1);
  });
});
