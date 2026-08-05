/**
 * mt#3370 — the embeddings index must report its own failures.
 *
 * These tests assert the SIGNAL, not the indexing. Indexing already worked;
 * what did not exist was any way to find out when it didn't. Every assertion
 * below pins a path that was previously silent (`log.debug`, a bare counter, an
 * unannotated early return, or `.catch(() => {})`), because the defect this
 * task fixes is precisely that a missing embedding produced no observable
 * event anywhere.
 *
 * Both files under test had NO test file before this one.
 *
 * mt#3629 / mt#3565 §Reframe: the degraded-path signal decisions are pure
 * functions (`classify*` below), asserted directly by return value. The
 * behavioral tests that follow use an injected `warn` collector instead of a
 * `log.warn` spy to verify the shell forwards them.
 */
import { describe, test, expect } from "bun:test";
import {
  autoIndexTaskEmbedding,
  classifyAutoIndexFailure,
  type AutoIndexDeps,
} from "./auto-index-embedding";
import {
  triggerStartupEmbeddingSweep,
  classifyNoSqlCapability,
  classifyNoRawConnection,
  classifyQuotaExhausted,
  classifyTaskIndexFailed,
  classifyResidualMeasurementFailed,
  classifySweepFinish,
} from "./startup-embedding-sweep";

/** Let the floating async IIFE inside autoIndexTaskEmbedding settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Shared fixture strings — extracted to satisfy `custom/no-magic-string-duplication`.
const EMBEDDING_PROVIDER_UNAVAILABLE = "embedding provider unavailable";
const NETWORK_UNREACHABLE = "network unreachable";

/** Collects (message, context) pairs from an injected warn sink. */
function collectingWarn() {
  const calls: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const warn = (message: string, context?: Record<string, unknown>) => {
    calls.push({ message, context });
  };
  return { warn, calls };
}

// ---------------------------------------------------------------------------
// Pure-core tests: classifyAutoIndexFailure
// ---------------------------------------------------------------------------

describe("classifyAutoIndexFailure (pure core)", () => {
  test("names the task id in both the message and the context", () => {
    const signal = classifyAutoIndexFailure("mt#3459", new Error(EMBEDDING_PROVIDER_UNAVAILABLE));
    expect(signal.message).toContain("mt#3459");
    expect(signal.context).toEqual({ taskId: "mt#3459", error: EMBEDDING_PROVIDER_UNAVAILABLE });
  });

  test("coerces a non-Error throw to a string", () => {
    const signal = classifyAutoIndexFailure("mt#1", "boom");
    expect(signal.context.error).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// On-write path
// ---------------------------------------------------------------------------

function autoIndexDeps(
  indexTask: (id: string) => Promise<boolean>,
  autoIndex = true,
  warn?: AutoIndexDeps["warn"]
) {
  return {
    getConfiguration: () => ({ embeddings: { autoIndex } }),
    createTaskSimilarityService: async () => ({ indexTask }),
    getPersistenceProvider: () => ({}) as never,
    getTaskService: () => ({}) as never,
    warn,
  } satisfies AutoIndexDeps;
}

describe("mt#3370 — autoIndexTaskEmbedding reports a failed index", () => {
  test("wiring: warns, and names the task, when indexing throws", async () => {
    const { warn, calls } = collectingWarn();
    autoIndexTaskEmbedding(
      "mt#3459",
      autoIndexDeps(
        async () => {
          throw new Error(EMBEDDING_PROVIDER_UNAVAILABLE);
        },
        true,
        warn
      )
    );
    await flush();

    expect(calls).toHaveLength(1);
    // The task id must be recoverable from the log, otherwise the operator
    // learns that "something" failed to index and cannot act on it.
    expect(calls[0]?.message).toContain("mt#3459");
    expect(calls[0]?.context).toMatchObject({ taskId: "mt#3459" });
    expect(String(calls[0]?.context?.["error"])).toContain(EMBEDDING_PROVIDER_UNAVAILABLE);
  });

  test("a successful index stays quiet", async () => {
    const { warn, calls } = collectingWarn();
    autoIndexTaskEmbedding(
      "mt#1",
      autoIndexDeps(async () => true, true, warn)
    );
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("a deliberate autoIndex opt-out stays quiet", async () => {
    const { warn, calls } = collectingWarn();
    autoIndexTaskEmbedding(
      "mt#1",
      autoIndexDeps(
        async () => {
          throw new Error("should never be called");
        },
        false,
        warn
      )
    );
    await flush();
    expect(calls).toHaveLength(0);
  });

  test("never throws into the caller, even when the deps themselves blow up", async () => {
    const { warn, calls } = collectingWarn();
    expect(() =>
      autoIndexTaskEmbedding("mt#1", {
        getConfiguration: () => {
          throw new Error("config exploded");
        },
        getPersistenceProvider: () => ({}) as never,
        getTaskService: () => ({}) as never,
        warn,
      } satisfies AutoIndexDeps)
    ).not.toThrow();
    await flush();
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Recovery layer — pure-core tests for the sweep's degraded-path signals
// ---------------------------------------------------------------------------

describe("classifyNoSqlCapability / classifyNoRawConnection / classifyQuotaExhausted (pure cores)", () => {
  test("each names the mechanism that's unavailable", () => {
    expect(classifyNoSqlCapability().message).toContain("no SQL capability");
    expect(classifyNoRawConnection().message).toContain("no raw SQL connection");
    expect(classifyQuotaExhausted().message).toContain("insufficient_quota");
  });
});

describe("classifyTaskIndexFailed (pure core)", () => {
  test("names the task and carries the error message", () => {
    const signal = classifyTaskIndexFailed("mt#7", new Error(NETWORK_UNREACHABLE));
    expect(signal.message).toContain("mt#7");
    expect(signal.context).toEqual({ error: NETWORK_UNREACHABLE });
  });
});

describe("classifyResidualMeasurementFailed (pure core)", () => {
  test("carries the underlying error", () => {
    const signal = classifyResidualMeasurementFailed(new Error("driver shape changed"));
    expect(signal.message).toContain("could not re-measure residual");
    expect(signal.context).toEqual({ error: "driver shape changed" });
  });
});

describe("classifySweepFinish (pure core)", () => {
  test("a clean run (no failures, no quota stop, nothing still missing) stays quiet", () => {
    const result = classifySweepFinish({
      indexed: 2,
      failed: 0,
      stillMissing: 0,
      hitScanLimit: false,
      quotaExhausted: false,
    });
    expect(result).toBeNull();
  });

  test("reports the MEASURED residual, not initial-minus-indexed", () => {
    // PR #2473 R1: the caller passes the re-measured `stillMissing`, not an
    // inferred count — this function just has to report whatever it's given.
    const result = classifySweepFinish({
      indexed: 0,
      failed: 1,
      stillMissing: 7,
      hitScanLimit: false,
      quotaExhausted: false,
    });
    expect(result?.message).toContain("still missing 7");
  });

  test("names the scan limit and the quota stop when both apply", () => {
    const result = classifySweepFinish({
      indexed: 1,
      failed: 0,
      stillMissing: 19,
      hitScanLimit: true,
      quotaExhausted: true,
    });
    expect(result?.message).toContain("hit the 50-task scan limit");
    expect(result?.message).toContain("stopped early on OpenAI quota exhaustion");
  });
});

// ---------------------------------------------------------------------------
// Recovery layer — wiring tests: the shell forwards the classify* decisions
// ---------------------------------------------------------------------------

/**
 * Minimal persistence-provider stand-in shaped for the sweep's two guards.
 *
 * `unsafe` serves two different queries: the initial missing-task list, then
 * (PR #2473 R1) the residual re-measurement. `residual` controls the second.
 */
function provider(opts: {
  sql?: boolean;
  rawRows?: Array<{ id: string }> | null;
  residual?: number;
}) {
  const base: Record<string, unknown> = {
    capabilities: { sql: opts.sql ?? true },
  };
  if (opts.rawRows !== null) {
    let call = 0;
    base["getRawSqlConnection"] = async () => ({
      unsafe: async () => {
        call += 1;
        // First call: the missing-task list. Second: the residual count.
        if (call === 1) return opts.rawRows ?? [];
        return [{ n: opts.residual ?? 0 }];
      },
    });
  }
  return base as never;
}

const sweepDeps = { getConfiguration: () => ({ embeddings: { autoIndex: true } }) };

describe("mt#3370 — the startup sweep reports when it cannot run (wiring)", () => {
  test("warns when the provider has no SQL capability", async () => {
    const { warn, calls } = collectingWarn();
    await triggerStartupEmbeddingSweep(provider({ sql: false }), {} as never, {
      ...sweepDeps,
      warn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toContain("no SQL capability");
  });

  test("warns when no raw SQL connection is available", async () => {
    const { warn, calls } = collectingWarn();
    await triggerStartupEmbeddingSweep(provider({ rawRows: null }), {} as never, {
      ...sweepDeps,
      warn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toContain("no raw SQL connection");
  });

  test("a sweep with nothing to do stays quiet", async () => {
    const { warn, calls } = collectingWarn();
    await triggerStartupEmbeddingSweep(provider({ rawRows: [] }), {} as never, {
      ...sweepDeps,
      warn,
    });
    expect(calls).toHaveLength(0);
  });

  test("a deliberate autoIndex opt-out returns without inspecting the provider", async () => {
    const { warn, calls } = collectingWarn();
    // `sql: false` would warn if the gate did not short-circuit first.
    await triggerStartupEmbeddingSweep(provider({ sql: false }), {} as never, {
      getConfiguration: () => ({ embeddings: { autoIndex: false } }),
      warn,
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR #2473 R1 — the sweep's own bookkeeping (wiring)
// ---------------------------------------------------------------------------

/** A task-service stand-in whose indexTask behavior the test controls. */
function svcThatThrows(msg: string) {
  return {
    createTaskSimilarityService: async () => ({
      indexTask: async () => {
        throw new Error(msg);
      },
    }),
  };
}

describe("PR #2473 R1 — quota exhaustion stops every worker, not just one (wiring)", () => {
  test("a quota error stops the sweep rather than letting siblings keep calling", async () => {
    const { warn, calls } = collectingWarn();
    let indexCalls = 0;
    const rows = Array.from({ length: 20 }, (_, n) => ({ id: `mt#${n}` }));

    // ONLY the first call reports quota exhaustion; every later call would
    // succeed. This is what makes the test discriminating: if each call threw
    // quota, both workers would break on their OWN error and the test would
    // pass with or without the shared-flag read — proving nothing. With just
    // one quota error, the sibling worker has no error of its own to stop it,
    // so it drains all 20 unless it reads the flag.
    await triggerStartupEmbeddingSweep(
      provider({ rawRows: rows, residual: 19 }),
      {} as never,
      {
        ...sweepDeps,
        warn,
        createTaskSimilarityService: async () => ({
          indexTask: async () => {
            indexCalls += 1;
            if (indexCalls === 1) {
              throw new Error("insufficient_quota: you exceeded your current quota");
            }
            return true;
          },
        }),
      } as never
    );

    // Concurrency is 2, so the sibling may already have one call in flight.
    // Without the fix this reaches 20.
    expect(indexCalls).toBeLessThanOrEqual(2);
    const messages = calls.map((c) => c.message);
    expect(messages.some((m) => m.includes("quota exhausted"))).toBe(true);
    expect(messages.some((m) => m.includes("stopped early on OpenAI quota exhaustion"))).toBe(true);
  });
});

describe("PR #2473 R1 — the residual count is measured, not inferred (wiring)", () => {
  test("reports the re-measured residual, not initial-minus-indexed", async () => {
    const { warn, calls } = collectingWarn();
    const rows = [{ id: "mt#1" }, { id: "mt#2" }];

    // Both indexTask calls return FALSE (an up-to-date skip), so `indexed`
    // stays 0 and the old arithmetic would have claimed "still missing 2".
    // The re-measurement says 0, which is the truth.
    await triggerStartupEmbeddingSweep(
      provider({ rawRows: rows, residual: 0 }),
      {} as never,
      {
        ...sweepDeps,
        warn,
        createTaskSimilarityService: async () => ({ indexTask: async () => false }),
      } as never
    );

    // Residual 0 and no failures => nothing to warn about at all.
    expect(calls).toHaveLength(0);
  });

  test("a real residual is reported, and reports the measured number", async () => {
    const { warn, calls } = collectingWarn();
    const rows = [{ id: "mt#1" }];
    await triggerStartupEmbeddingSweep(
      provider({ rawRows: rows, residual: 7 }),
      {} as never,
      {
        ...sweepDeps,
        warn,
        ...svcThatThrows(NETWORK_UNREACHABLE),
      } as never
    );

    const summary = calls.map((c) => c.message).find((m) => m.includes("still missing"));
    expect(summary).toBeDefined();
    // 7 is the measured residual; initial(1) - indexed(0) would have said 1.
    expect(summary).toContain("still missing 7");
  });
});
