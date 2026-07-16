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
