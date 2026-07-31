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
 */
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { log } from "@minsky/shared/logger";
import { autoIndexTaskEmbedding, type AutoIndexDeps } from "./auto-index-embedding";
import { triggerStartupEmbeddingSweep } from "./startup-embedding-sweep";

/** Let the floating async IIFE inside autoIndexTaskEmbedding settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const spies: Array<{ mockRestore: () => void }> = [];
function captureWarn() {
  const spy = spyOn(log, "warn").mockImplementation(() => {});
  spies.push(spy);
  return spy;
}
function captureDebug() {
  const spy = spyOn(log, "debug").mockImplementation(() => {});
  spies.push(spy);
  return spy;
}

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

// ---------------------------------------------------------------------------
// On-write path
// ---------------------------------------------------------------------------

function autoIndexDeps(indexTask: (id: string) => Promise<boolean>, autoIndex = true) {
  return {
    getConfiguration: () => ({ embeddings: { autoIndex } }),
    createTaskSimilarityService: async () => ({ indexTask }),
    getPersistenceProvider: () => ({}) as never,
    getTaskService: () => ({}) as never,
  } satisfies AutoIndexDeps;
}

describe("mt#3370 — autoIndexTaskEmbedding reports a failed index", () => {
  test("warns, and names the task, when indexing throws", async () => {
    const warn = captureWarn();
    autoIndexTaskEmbedding("mt#3459", {
      ...autoIndexDeps(async () => {
        throw new Error("embedding provider unavailable");
      }),
    });
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
    // The task id must be recoverable from the log, otherwise the operator
    // learns that "something" failed to index and cannot act on it.
    expect(message).toContain("mt#3459");
    expect(context).toMatchObject({ taskId: "mt#3459" });
    expect(String(context["error"])).toContain("embedding provider unavailable");
  });

  test("the failure is NOT reported at debug — that is the bug being fixed", async () => {
    const debug = captureDebug();
    const warn = captureWarn();
    autoIndexTaskEmbedding("mt#2861", {
      ...autoIndexDeps(async () => {
        throw new Error("boom");
      }),
    });
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    // Before mt#3370 this exact failure produced a debug line and nothing else.
    const debugMentionsFailure = debug.mock.calls.some((args) =>
      String(args[0] ?? "").includes("mt#2861")
    );
    expect(debugMentionsFailure).toBe(false);
  });

  test("a successful index stays quiet", async () => {
    const warn = captureWarn();
    autoIndexTaskEmbedding("mt#1", { ...autoIndexDeps(async () => true) });
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  test("a deliberate autoIndex opt-out stays quiet", async () => {
    const warn = captureWarn();
    autoIndexTaskEmbedding(
      "mt#1",
      autoIndexDeps(async () => {
        throw new Error("should never be called");
      }, false)
    );
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  test("never throws into the caller, even when the deps themselves blow up", async () => {
    const warn = captureWarn();
    expect(() =>
      autoIndexTaskEmbedding("mt#1", {
        getConfiguration: () => {
          throw new Error("config exploded");
        },
        getPersistenceProvider: () => ({}) as never,
        getTaskService: () => ({}) as never,
      } satisfies AutoIndexDeps)
    ).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Recovery layer
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

describe("mt#3370 — the startup sweep reports when it cannot run", () => {
  test("warns when the provider has no SQL capability", async () => {
    const warn = captureWarn();
    await triggerStartupEmbeddingSweep(provider({ sql: false }), {} as never, sweepDeps);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("no SQL capability");
  });

  test("warns when no raw SQL connection is available", async () => {
    const warn = captureWarn();
    await triggerStartupEmbeddingSweep(provider({ rawRows: null }), {} as never, sweepDeps);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("no raw SQL connection");
  });

  test("a sweep with nothing to do stays quiet", async () => {
    const warn = captureWarn();
    await triggerStartupEmbeddingSweep(provider({ rawRows: [] }), {} as never, sweepDeps);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a deliberate autoIndex opt-out returns without inspecting the provider", async () => {
    const warn = captureWarn();
    // `sql: false` would warn if the gate did not short-circuit first.
    await triggerStartupEmbeddingSweep(provider({ sql: false }), {} as never, {
      getConfiguration: () => ({ embeddings: { autoIndex: false } }),
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR #2473 R1 — the sweep's own bookkeeping
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

describe("PR #2473 R1 — quota exhaustion stops every worker, not just one", () => {
  test("a quota error stops the sweep rather than letting siblings keep calling", async () => {
    const warn = captureWarn();
    let calls = 0;
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
        createTaskSimilarityService: async () => ({
          indexTask: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error("insufficient_quota: you exceeded your current quota");
            }
            return true;
          },
        }),
      } as never
    );

    // Concurrency is 2, so the sibling may already have one call in flight.
    // Without the fix this reaches 20.
    expect(calls).toBeLessThanOrEqual(2);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("quota exhausted"))).toBe(true);
    expect(messages.some((m) => m.includes("stopped early on OpenAI quota exhaustion"))).toBe(true);
  });
});

describe("PR #2473 R1 — the residual count is measured, not inferred", () => {
  test("reports the re-measured residual, not initial-minus-indexed", async () => {
    const warn = captureWarn();
    const rows = [{ id: "mt#1" }, { id: "mt#2" }];

    // Both indexTask calls return FALSE (an up-to-date skip), so `indexed`
    // stays 0 and the old arithmetic would have claimed "still missing 2".
    // The re-measurement says 0, which is the truth.
    await triggerStartupEmbeddingSweep(
      provider({ rawRows: rows, residual: 0 }),
      {} as never,
      {
        ...sweepDeps,
        createTaskSimilarityService: async () => ({ indexTask: async () => false }),
      } as never
    );

    // Residual 0 and no failures => nothing to warn about at all.
    expect(warn).not.toHaveBeenCalled();
  });

  test("a real residual is reported, and reports the measured number", async () => {
    const warn = captureWarn();
    const rows = [{ id: "mt#1" }];
    await triggerStartupEmbeddingSweep(
      provider({ rawRows: rows, residual: 7 }),
      {} as never,
      {
        ...sweepDeps,
        ...svcThatThrows("network unreachable"),
      } as never
    );

    const summary = warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("still missing"));
    expect(summary).toBeDefined();
    // 7 is the measured residual; initial(1) - indexed(0) would have said 1.
    expect(summary).toContain("still missing 7");
  });
});
