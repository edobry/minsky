/**
 * Tests for TitlePipeline (mt#3321, extended mt#4179).
 *
 * Covers the properties that make the sweeper safe to run on a timer:
 *  - only untitled, not-already-attempted rows are candidates (idempotent
 *    re-run AND a batch window that advances — mt#4179)
 *  - an attempted row that produced no title LEAVES the candidate set, and
 *    re-enters it only when new content arrives
 *  - the batch bound is respected (API-spend control)
 *  - a provider failure is COUNTED and the row left completely unwritten for
 *    retry — never swallowed into a "nothing to do" result (mem#682)
 *  - a skip records WHY, so the permanently-untitleable population is
 *    countable rather than inferred from a `skipped` number that looks
 *    identical to a healthy quiet tick
 *  - `force` re-titles rows that already have a title
 *
 * Fake DB mirrors the three statements the pipeline issues, following the
 * per-turn-embedding-pipeline.test.ts convention.
 *
 * @see ./title-pipeline.ts
 */

import { describe, test, expect } from "bun:test";

import { TitlePipeline } from "./title-pipeline";
import type { TitleTurn } from "./title-generator";
import type { CognitionProvider, CognitionTask, CognitionResult } from "../cognition/types";

interface SeedRow {
  agentSessionId: string;
  /** Rows of `agent_transcript_turns` for this conversation, in turn order. */
  turns: TitleTurn[];
  title: string | null;
  titleAttemptedAt?: Date | null;
  titleSkipReason?: "no-turns" | "no-content" | "no-subject" | null;
  lastIngestedJsonlTimestamp?: Date | null;
}

/** One text-bearing turn — enough for the generator to build a prompt. */
function turn(text: string): TitleTurn {
  return { userText: text, assistantText: null };
}

interface AppliedUpdate {
  title?: string | null;
  titleAttemptedAt?: Date;
  titleSkipReason?: string | null;
}

/**
 * Models the three statements the pipeline issues:
 *   select({agentSessionId}).from(t)[.where(...)].orderBy(...).limit(n)
 *   select({userText, assistantText}).from(turns).where(...).orderBy(...).limit(n)
 *   update(t).set({...}).where(agentSessionId = ...)
 *
 * The two selects are told apart by their FIELD MAP, which is the same thing
 * the real query builder keys on and is not opaque the way a drizzle WHERE is.
 *
 * The candidate filter is simulated rather than read off the WHERE: the WHERE
 * is a drizzle SQL object and is not safely introspectable (JSON.stringify
 * throws on its circular refs). `candidateConditionCount()` is the seam that
 * asserts the real builder's shape; this fake asserts the pipeline's BEHAVIOR
 * given that filter's semantics.
 */
function makeDb(seed: SeedRow[], opts: { force?: boolean; failSelect?: boolean } = {}) {
  const store = new Map<string, SeedRow>();
  for (const s of seed) store.set(s.agentSessionId, { ...s });
  let lastLimit = Infinity;
  /** Updates in call order — the correlation seam (see `update` below). */
  const applied: AppliedUpdate[] = [];
  /**
   * Candidate ids in select order. Each candidate issues exactly one turns
   * query, first thing, so shifting this queue correlates a turns lookup to
   * its row without introspecting the opaque WHERE. Same FIFO rationale the
   * update recorder below uses.
   */
  let turnLookupQueue: string[] = [];

  const hasTextTurn = (r: SeedRow): boolean =>
    (r.turns ?? []).some((t) => t.userText !== null || t.assistantText !== null);

  const isCandidate = (r: SeedRow): boolean => {
    if (opts.force) return true;
    if (r.title !== null) return false;
    if (!r.titleAttemptedAt) return true;
    // Re-ask when content arrived after the attempt...
    if (r.lastIngestedJsonlTimestamp && r.lastIngestedJsonlTimestamp > r.titleAttemptedAt) {
      return true;
    }
    // ...or when the attempt saw NO turn row and one has since landed. Scoped
    // to `no-turns` so it terminates — see the pipeline's candidateConditions.
    return r.titleSkipReason === "no-turns" && hasTextTurn(r);
  };

  const candidateSelect = () => {
    const runQuery = (n: number) => {
      if (opts.failSelect) return Promise.reject(new Error("db down"));
      lastLimit = n;
      const cands = [...store.values()].filter(isCandidate).slice(0, n);
      turnLookupQueue = cands.map((r) => r.agentSessionId);
      return Promise.resolve(cands.map((r) => ({ agentSessionId: r.agentSessionId })));
    };
    const tail = { orderBy: (_o: unknown) => ({ limit: runQuery }) };
    // `.where()` is OPTIONAL on this chain: under force the pipeline builds no
    // conditions and calls `.orderBy()` straight off `.from()`.
    return { ...tail, where: (_cond: unknown) => tail };
  };

  const turnsSelect = () => ({
    where: (_cond: unknown) => ({
      orderBy: (_o: unknown) => ({
        limit: (_n: number) => {
          const id = turnLookupQueue.shift();
          const row = id ? store.get(id) : undefined;
          // Mirrors the SQL filter: rows with both text columns NULL never come back.
          const rows = (row?.turns ?? []).filter(
            (t) => t.userText !== null || t.assistantText !== null
          );
          return Promise.resolve(rows);
        },
      }),
    }),
  });

  const db = {
    select(fields?: Record<string, unknown>) {
      const isTurnQuery = !!fields && "userText" in fields;
      return { from: (_table: unknown) => (isTurnQuery ? turnsSelect() : candidateSelect()) };
    },
    update(_table: unknown) {
      return {
        set(vals: AppliedUpdate) {
          return {
            where: (_cond: unknown): Promise<void> => {
              applied.push(vals);
              return Promise.resolve();
            },
          };
        },
      };
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
      { agentSessionId: "s1", turns: [turn("why is the build failing")], title: null },
    ]);
    const result = await makePipeline(
      db,
      makeProvider(() => "Build failure triage")
    ).run();

    expect(result.titled).toBe(1);
    expect(result.errored).toBe(0);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.title).toBe("Build failure triage");
    // The attempt is stamped on success too, so `title_attempted_at` means
    // "asked", not "failed".
    expect(applied[0]?.titleAttemptedAt).toBeInstanceOf(Date);
    expect(applied[0]?.titleSkipReason).toBeNull();
  });

  test("does not re-title a row that already has a title (idempotent re-run)", async () => {
    const { db, applied } = makeDb([
      { agentSessionId: "s1", turns: [turn("hello")], title: "Existing title" },
    ]);
    const provider = makeProvider(() => "Should not be used");
    const result = await makePipeline(db, provider).run();

    expect(result.candidates).toBe(0);
    expect(result.titled).toBe(0);
    expect(provider.calls).toBe(0);
    expect(applied).toEqual([]);
  });

  test("force re-titles rows that already have a title", async () => {
    const { db, applied } = makeDb(
      [{ agentSessionId: "s1", turns: [turn("hello")], title: "Stale title" }],
      { force: true }
    );
    const result = await makePipeline(
      db,
      makeProvider(() => "Fresh title"),
      { force: true }
    ).run();

    expect(result.titled).toBe(1);
    expect(applied[0]?.title).toBe("Fresh title");
  });

  // ── mt#4179: the batch window must ADVANCE ────────────────────────────────
  //
  // The defect these pin: with `WHERE title IS NULL` as the whole work set, a
  // row that can never be titled is re-selected on every tick. Ordered
  // newest-first, ~29 such rows filled a 25-row batch and the 1,289 untitled
  // rows beneath them were unreachable — 15 consecutive sweeps of 25
  // candidates / ~25 skipped / 0 titled.
  describe("head-of-line blocking (mt#4179)", () => {
    test("a row already asked, with no new content, is NOT a candidate again", async () => {
      const asked = new Date("2026-08-16T00:00:00Z");
      const { db } = makeDb([
        {
          agentSessionId: "permanently-untitleable",
          turns: [turn("k")],
          title: null,
          titleAttemptedAt: asked,
          lastIngestedJsonlTimestamp: new Date("2026-08-15T00:00:00Z"),
        },
      ]);
      const provider = makeProvider(() => "unused");
      const result = await makePipeline(db, provider).run();

      expect(result.candidates).toBe(0);
      expect(provider.calls).toBe(0);
    });

    test("the stuck row does not crowd out an untried row behind it", async () => {
      const asked = new Date("2026-08-16T00:00:00Z");
      const provider = makeProvider(() => "Retry logic in session start");
      const { db, applied } = makeDb([
        {
          agentSessionId: "stuck",
          turns: [turn("k")],
          title: null,
          titleAttemptedAt: asked,
          lastIngestedJsonlTimestamp: null,
        },
        { agentSessionId: "never-tried", turns: [turn("the retry bug")], title: null },
      ]);
      // batchSize 1 is the whole point: under the old work set the stuck row
      // occupies the only slot forever and `never-tried` is never reached.
      const result = await makePipeline(db, provider, { batchSize: 1 }).run();

      expect(result.candidates).toBe(1);
      expect(result.titled).toBe(1);
      expect(applied[0]?.title).toBe("Retry logic in session start");
    });

    test("a `no-turns` row re-enters once a text-bearing turn lands", async () => {
      // The two-channel race: content comes from `agent_transcript_turns`, but
      // the ordinary re-ask trigger is the BLOB-ingest high-water mark, which
      // ingest writes BEFORE the turn rows (and which the embeddings-path
      // re-materialization never bumps). An attempt landing in that window sees
      // zero turns for a conversation that has content; without this clause the
      // HWM would never re-open it.
      const { db } = makeDb([
        {
          agentSessionId: "raced",
          turns: [turn("the turns landed after the attempt did")],
          title: null,
          titleAttemptedAt: new Date("2026-08-16T00:00:00Z"),
          titleSkipReason: "no-turns",
          // Deliberately STALE — the HWM clause cannot save this row.
          lastIngestedJsonlTimestamp: new Date("2026-08-15T00:00:00Z"),
        },
      ]);
      const result = await makePipeline(
        db,
        makeProvider(() => "Turn materialization race")
      ).run();

      expect(result.candidates).toBe(1);
      expect(result.titled).toBe(1);
    });

    test("the re-ask clause TERMINATES — a `no-content` row is not re-selected", async () => {
      // Scoping the EXISTS clause to `no-turns` is what keeps it from becoming
      // the very defect this task fixes: a markup-only conversation HAS
      // text-bearing turn rows, so a clause matching any skip reason would
      // re-select it on every tick forever.
      const { db } = makeDb([
        {
          agentSessionId: "markup-only",
          turns: [turn("<command-message>error-handling</command-message>")],
          title: null,
          titleAttemptedAt: new Date("2026-08-16T00:00:00Z"),
          titleSkipReason: "no-content",
          lastIngestedJsonlTimestamp: new Date("2026-08-15T00:00:00Z"),
        },
      ]);
      const result = await makePipeline(
        db,
        makeProvider(() => "unused")
      ).run();

      expect(result.candidates).toBe(0);
    });

    test("a row asked BEFORE new content arrived is reconsidered", async () => {
      const { db } = makeDb([
        {
          agentSessionId: "grew-since",
          turns: [turn("now there is more to go on")],
          title: null,
          titleAttemptedAt: new Date("2026-08-15T00:00:00Z"),
          lastIngestedJsonlTimestamp: new Date("2026-08-16T00:00:00Z"),
        },
      ]);
      const result = await makePipeline(
        db,
        makeProvider(() => "A real subject")
      ).run();

      expect(result.candidates).toBe(1);
      expect(result.titled).toBe(1);
    });
  });

  // PR #2408 R1: the force branch previously relied on drizzle dropping a
  // conditional `undefined` inside `and(...)`. The fake DB above ignores the
  // WHERE entirely, so no test actually exercised that. These assert the query
  // SHAPE against the real condition builder instead.
  describe("candidate query shape (real drizzle conditions)", () => {
    test("normal mode filters on both untitled AND not-already-asked", () => {
      const { db } = makeDb([]);
      expect(
        makePipeline(
          db,
          makeProvider(() => "x")
        ).candidateConditionCount()
      ).toBe(2);
    });

    test("force mode drops every filter — and the WHERE is omitted, not undefined", () => {
      const { db } = makeDb([]);
      expect(
        makePipeline(
          db,
          makeProvider(() => "x"),
          { force: true }
        ).candidateConditionCount()
      ).toBe(0);
    });

    test("the smoke script IMPORTS the filter rather than restating it", async () => {
      // PR #3040 R1: the smoke script's preview drifted from the pipeline twice
      // inside this task while it kept its own copy of the filter — first
      // missing the attempt clause, then missing the `no-turns` re-ask clause.
      // A structural pin is the only thing that survives the next change to
      // the filter, since a behavioral test of the script needs a live DB.
      const source = await Bun.file(
        new URL("../../../../scripts/smoke-conversation-titles.ts", import.meta.url)
      ).text();

      expect(source).toContain("titleCandidateConditions");
      // The tell of a restated copy: the script naming the filter's own columns.
      expect(source).not.toContain("titleAttemptedAt");
    });

    test("force still issues a working query with no WHERE at all", async () => {
      // The behavioral half of the assertion above: with zero conditions the
      // pipeline must call `.orderBy()` directly off `.from()` rather than
      // passing `and()`'s `undefined` into `.where()`. The fake's candidate
      // chain makes `.where` optional, so a regression to the undefined-hole
      // form would still pass — what this catches is the pipeline FAILING to
      // build a query at all when it has nothing to filter on.
      const { db } = makeDb([{ agentSessionId: "s1", turns: [turn("hi")], title: "has one" }], {
        force: true,
      });
      const result = await makePipeline(
        db,
        makeProvider(() => "Fresh"),
        { force: true }
      ).run();
      expect(result.candidates).toBe(1);
    });
  });

  test("respects the batch bound — the API-spend control", async () => {
    const seed: SeedRow[] = Array.from({ length: 10 }, (_, i) => ({
      agentSessionId: `s${i}`,
      turns: [turn(`conversation ${i}`)],
      title: null,
    }));
    const { db, getLastLimit } = makeDb(seed);
    const provider = makeProvider(() => "A title");
    const result = await makePipeline(db, provider, { batchSize: 3 }).run();

    expect(getLastLimit()).toBe(3);
    expect(result.candidates).toBe(3);
    expect(provider.calls).toBe(3);
  });

  test("a provider failure is COUNTED and leaves the row entirely unwritten", async () => {
    const { db, applied } = makeDb([{ agentSessionId: "s1", turns: [turn("hello")], title: null }]);
    const result = await makePipeline(
      db,
      makeProvider(() => ({ throw: "rate limited" }))
    ).run();

    expect(result.errored).toBe(1);
    expect(result.titled).toBe(0);
    // Critically: NO write at all — no placeholder title, and no attempt stamp
    // either. A model outage must not be recorded as a verdict about the
    // conversation, or one bad afternoon would permanently retire every row it
    // touched.
    expect(applied).toEqual([]);
  });

  test("one row failing does not abort the rest of the batch", async () => {
    const { db, applied } = makeDb([
      { agentSessionId: "s1", turns: [turn("first")], title: null },
      { agentSessionId: "s2", turns: [turn("second")], title: null },
    ]);
    const provider = makeProvider((prompt) =>
      prompt.includes("first") ? { throw: "boom" } : "Second title"
    );
    const result = await makePipeline(db, provider).run();

    expect(result.errored).toBe(1);
    expect(result.titled).toBe(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.title).toBe("Second title");
  });

  test("a no-subject answer records the attempt with its reason, not a title", async () => {
    const { db, applied } = makeDb([{ agentSessionId: "s1", turns: [turn("k")], title: null }]);
    const result = await makePipeline(
      db,
      makeProvider(() => "Untitled")
    ).run();

    expect(result.skipped).toBe(1);
    expect(result.skippedNoSubject).toBe(1);
    expect(result.titled).toBe(0);
    expect(result.errored).toBe(0);
    // The write is the ATTEMPT record, not a placeholder title.
    expect(applied).toHaveLength(1);
    expect(applied[0]?.title).toBeUndefined();
    expect(applied[0]?.titleSkipReason).toBe("no-subject");
  });

  test("a conversation with no text-bearing turn is skipped without a model call", async () => {
    const { db, applied } = makeDb([
      { agentSessionId: "s1", turns: [{ userText: null, assistantText: null }], title: null },
    ]);
    const provider = makeProvider(() => "unused");
    const result = await makePipeline(db, provider).run();

    expect(result.skipped).toBe(1);
    expect(result.skippedNoTurns).toBe(1);
    expect(provider.calls).toBe(0);
    expect(applied[0]?.titleSkipReason).toBe("no-turns");
  });

  test("markup-only content is `no-content`, NOT a model verdict", async () => {
    // The distinction that makes the counters readable: `no-subject` must mean
    // the model looked and declined. A row that was never sent to the model is
    // a different fact, and collapsing the two would report a verdict for a
    // call that never happened.
    const { db, applied } = makeDb([
      {
        agentSessionId: "s1",
        turns: [turn("<command-message>error-handling</command-message>")],
        title: null,
      },
    ]);
    const provider = makeProvider(() => "unused");
    const result = await makePipeline(db, provider).run();

    expect(result.skippedNoContent).toBe(1);
    expect(result.skippedNoSubject).toBe(0);
    expect(provider.calls).toBe(0);
    expect(applied[0]?.titleSkipReason).toBe("no-content");
  });

  test("a failed candidate query degrades to a zeroed result instead of throwing", async () => {
    const { db } = makeDb([{ agentSessionId: "s1", turns: [turn("x")], title: null }], {
      failSelect: true,
    });
    const result = await makePipeline(
      db,
      makeProvider(() => "unused")
    ).run();

    expect(result).toEqual({
      candidates: 0,
      titled: 0,
      skipped: 0,
      skippedNoTurns: 0,
      skippedNoContent: 0,
      skippedNoSubject: 0,
      errored: 0,
    });
  });
});
