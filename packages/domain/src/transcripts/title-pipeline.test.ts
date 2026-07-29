/**
 * Tests for TitlePipeline (mt#3321).
 *
 * Covers the properties that make the sweeper safe to run on a timer:
 *  - only untitled rows are candidates (idempotent re-run)
 *  - the batch bound is respected (API-spend control)
 *  - a provider failure is COUNTED and the row left NULL for retry — never
 *    swallowed into a "nothing to do" result (mem#682)
 *  - a skip (empty transcript / no subject) writes nothing
 *  - `force` re-titles rows that already have a title
 *
 * Fake DB mirrors the two statements the pipeline issues, following the
 * per-turn-embedding-pipeline.test.ts convention.
 *
 * @see ./title-pipeline.ts
 */

import { describe, test, expect } from "bun:test";

import { TitlePipeline } from "./title-pipeline";
import type { CognitionProvider, CognitionTask, CognitionResult } from "../cognition/types";

interface SeedRow {
  agentSessionId: string;
  transcript: unknown;
  title: string | null;
}

/** One raw JSONL-ish user line — enough for `extractTurns` to yield a turn. */
function rawTranscript(text: string): unknown {
  return [
    {
      type: "user",
      timestamp: "2026-07-29T16:10:14.982Z",
      message: { role: "user", content: text },
    },
  ];
}

/**
 * Models:
 *   select({...}).from(t).where(transcript NOT NULL [AND title IS NULL]).orderBy(...).limit(n)
 *   update(t).set({title}).where(agentSessionId = ...)
 *
 * `force` is inferred the same way the pipeline builds its WHERE: when force
 * is on, titled rows remain candidates.
 */
function makeDb(seed: SeedRow[], opts: { force?: boolean; failSelect?: boolean } = {}) {
  const store = new Map<string, SeedRow>();
  for (const s of seed) store.set(s.agentSessionId, { ...s });
  let lastLimit = Infinity;
  /** Titles written, in update order — the correlation seam (see `update` below). */
  const applied: Array<string | null> = [];

  const db = {
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => ({
            orderBy: (_o: unknown) => ({
              limit: (n: number) => {
                if (opts.failSelect) return Promise.reject(new Error("db down"));
                lastLimit = n;
                const cands = [...store.values()]
                  .filter((r) => r.transcript !== null && r.transcript !== undefined)
                  .filter((r) => (opts.force ? true : r.title === null))
                  .slice(0, n);
                return Promise.resolve(
                  cands.map((r) => ({
                    agentSessionId: r.agentSessionId,
                    transcript: r.transcript,
                  }))
                );
              },
            }),
          }),
        }),
      };
    },
    update(_table: unknown) {
      return {
        set(vals: { title?: string }) {
          return {
            where: (_cond: unknown): Promise<void> => {
              // The WHERE is a drizzle SQL object — opaque, and not safely
              // introspectable (JSON.stringify on it throws on circular refs).
              // Record the applied titles in call order instead; the pipeline
              // processes candidates sequentially in select order, so order is
              // sufficient to correlate. Mirrors the FIFO approach in
              // per-turn-embedding-pipeline.test.ts.
              applied.push(vals.title ?? null);
              return Promise.resolve();
            },
          };
        },
      };
    },
    get lastLimit() {
      return lastLimit;
    },
  };

  return { db, store, applied, getLastLimit: () => lastLimit };
}

function makeProvider(
  titleFor: (userPrompt: string) => string | { throw: string }
): CognitionProvider & { calls: number } {
  const provider = {
    calls: 0,
    async perform<T>(task: CognitionTask<T>): Promise<CognitionResult<T>> {
      provider.calls++;
      const out = titleFor(task.userPrompt);
      if (typeof out === "object") throw new Error(out.throw);
      return { kind: "completed", value: { title: out } } as unknown as CognitionResult<T>;
    },
    async performBatch(): Promise<never> {
      throw new Error("unused");
    },
  };
  return provider as unknown as CognitionProvider & { calls: number };
}

type FakeDb = ReturnType<typeof makeDb>["db"];
function makePipeline(
  db: FakeDb,
  provider: CognitionProvider,
  options?: { force?: boolean; batchSize?: number }
): TitlePipeline {
  return new TitlePipeline(
    db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase,
    provider,
    options ?? {}
  );
}

describe("TitlePipeline", () => {
  test("titles an untitled row and persists the result", async () => {
    const { db, applied } = makeDb([
      { agentSessionId: "s1", transcript: rawTranscript("why is the build failing"), title: null },
    ]);
    const result = await makePipeline(
      db,
      makeProvider(() => "Build failure triage")
    ).run();

    expect(result.titled).toBe(1);
    expect(result.errored).toBe(0);
    expect(applied).toEqual(["Build failure triage"]);
  });

  test("does not re-title a row that already has a title (idempotent re-run)", async () => {
    const { db, applied } = makeDb([
      { agentSessionId: "s1", transcript: rawTranscript("hello"), title: "Existing title" },
    ]);
    const provider = makeProvider(() => "Should not be used");
    const result = await makePipeline(db, provider).run();

    expect(result.candidates).toBe(0);
    expect(result.titled).toBe(0);
    expect(provider.calls).toBe(0);
    // No write attempted at all — the row keeps its existing title.
    expect(applied).toEqual([]);
  });

  test("force re-titles rows that already have a title", async () => {
    const { db, applied } = makeDb(
      [{ agentSessionId: "s1", transcript: rawTranscript("hello"), title: "Stale title" }],
      { force: true }
    );
    const result = await makePipeline(
      db,
      makeProvider(() => "Fresh title"),
      {
        force: true,
      }
    ).run();

    expect(result.titled).toBe(1);
    expect(applied).toEqual(["Fresh title"]);
  });

  // PR #2408 R1: the force branch previously relied on drizzle dropping a
  // conditional `undefined` inside `and(...)`. The fake DB above ignores the
  // WHERE entirely, so no test actually exercised that. These assert the query
  // SHAPE against the real condition builder instead.
  describe("candidate query shape (real drizzle conditions)", () => {
    test("normal mode filters on both has-transcript AND untitled", () => {
      const { db } = makeDb([]);
      expect(
        makePipeline(
          db,
          makeProvider(() => "x")
        ).candidateConditionCount()
      ).toBe(2);
    });

    test("force mode drops the untitled filter — one condition, never an undefined hole", () => {
      const { db } = makeDb([]);
      expect(
        makePipeline(
          db,
          makeProvider(() => "x"),
          { force: true }
        ).candidateConditionCount()
      ).toBe(1);
    });

    test("the built WHERE is a usable SQL expression in BOTH modes", () => {
      const { db } = makeDb([]);
      for (const force of [false, true]) {
        const conditions = makePipeline(
          db,
          makeProvider(() => "x"),
          {
            force,
          }
        ).candidateConditionCount();
        // Non-zero condition count is what keeps `and(...)` from collapsing to
        // `undefined` (which would drop the WHERE clause entirely and select
        // every row in the table).
        expect(conditions).toBeGreaterThan(0);
      }
    });
  });

  test("respects the batch bound — the API-spend control", async () => {
    const seed: SeedRow[] = Array.from({ length: 10 }, (_, i) => ({
      agentSessionId: `s${i}`,
      transcript: rawTranscript(`conversation ${i}`),
      title: null,
    }));
    const { db, getLastLimit } = makeDb(seed);
    const provider = makeProvider(() => "A title");
    const result = await makePipeline(db, provider, { batchSize: 3 }).run();

    expect(getLastLimit()).toBe(3);
    expect(result.candidates).toBe(3);
    expect(provider.calls).toBe(3);
  });

  test("a provider failure is COUNTED and leaves the row NULL for a later retry", async () => {
    const { db, applied } = makeDb([
      { agentSessionId: "s1", transcript: rawTranscript("hello"), title: null },
    ]);
    const result = await makePipeline(
      db,
      makeProvider(() => ({ throw: "rate limited" }))
    ).run();

    expect(result.errored).toBe(1);
    expect(result.titled).toBe(0);
    // Critically: NO write at all — no placeholder, no empty title. The row
    // stays NULL and is retried on the next tick.
    expect(applied).toEqual([]);
  });

  test("one row failing does not abort the rest of the batch", async () => {
    const { db, applied } = makeDb([
      { agentSessionId: "s1", transcript: rawTranscript("first"), title: null },
      { agentSessionId: "s2", transcript: rawTranscript("second"), title: null },
    ]);
    const provider = makeProvider((prompt) =>
      prompt.includes("first") ? { throw: "boom" } : "Second title"
    );
    const result = await makePipeline(db, provider).run();

    expect(result.errored).toBe(1);
    expect(result.titled).toBe(1);
    // Exactly one write, and it is the SECOND row's title — the failing row
    // wrote nothing rather than aborting the batch or writing a placeholder.
    expect(applied).toEqual(["Second title"]);
  });

  test("a no-subject answer is a skip, not a write and not an error", async () => {
    const { db, applied } = makeDb([
      { agentSessionId: "s1", transcript: rawTranscript("k"), title: null },
    ]);
    const result = await makePipeline(
      db,
      makeProvider(() => "Untitled")
    ).run();

    expect(result.skipped).toBe(1);
    expect(result.titled).toBe(0);
    expect(result.errored).toBe(0);
    expect(applied).toEqual([]);
  });

  test("an empty transcript is skipped without a model call", async () => {
    const { db } = makeDb([{ agentSessionId: "s1", transcript: [], title: null }]);
    const provider = makeProvider(() => "unused");
    const result = await makePipeline(db, provider).run();

    expect(result.skipped).toBe(1);
    expect(provider.calls).toBe(0);
  });

  test("a failed candidate query degrades to a zeroed result instead of throwing", async () => {
    const { db } = makeDb([{ agentSessionId: "s1", transcript: rawTranscript("x"), title: null }], {
      failSelect: true,
    });
    const result = await makePipeline(
      db,
      makeProvider(() => "unused")
    ).run();

    expect(result).toEqual({ candidates: 0, titled: 0, skipped: 0, errored: 0 });
  });
});
