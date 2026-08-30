/**
 * `MemoryService.getWithStaleness` — the annotating fetch-by-id (mt#4743).
 *
 * mt#1709 shipped read-time staleness annotation with exactly one call site:
 * inside `search()`. `get()` returned the row unannotated. That is the wrong
 * half for the highest-stakes read — an agent reaches a memory BY ID when
 * something already told it which memory matters (a handoff naming `mem#367`,
 * a spec cross-reference, a family root cited by a prior task), and those are
 * precisely the load-bearing reads. Search results — speculative, low-commitment
 * — got the banner.
 *
 * The assertions below are built around AT3's requirement that the SAME code
 * path return BOTH outcomes on inputs differing only in the referenced task's
 * status. That pairing is what this file is for: an annotator that fires always
 * and one that fires never each satisfy a one-sided test, and the originating
 * defect class here is precisely a check that cannot fail (mem#704).
 *
 * @see mt#4743 — this file's originating task
 * @see mt#1709 — the annotation this widens the binding of
 */
import { describe, test, expect } from "bun:test";
import { MemoryService, type MemoryServiceDb, type MemoryServiceDeps } from "./memory-service";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";

const UUID = "d8891fad-b156-46e1-8940-98067eb097a9";

/** A retirement clause in the shape `SELF_ANCHORED_PATTERNS` actually matches. */
const DECLARES_RETIREMENT = "Budget: retire when mt#1541 ships.";

/** Prose naming a task with no retirement relationship — the extractor must not fire. */
const NAMES_NO_RETIREMENT =
  "This memory discusses mt#1541 as a historical reference. It declares no budget.";

function rowWith(content: string, associations: Record<string, unknown> = {}) {
  return {
    id: UUID,
    short_id: "mem#728",
    type: "feedback",
    name: "a memory",
    description: "d",
    content,
    scope: "project",
    tags: [],
    associations,
    access_count: 0,
  };
}

/**
 * A db fake returning exactly one row. `update` is a no-op sink for the
 * fire-and-forget access-count bump `get()` performs.
 */
function dbReturning(row: ReturnType<typeof rowWith>): MemoryServiceDb {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    insert: () => {
      throw new Error("not used");
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    delete: () => {
      throw new Error("not used");
    },
    transaction: async () => {
      throw new Error("not used");
    },
  } as unknown as MemoryServiceDb;
}

/**
 * Build a service over one row plus a COUNTING status lookup.
 *
 * The counter is load-bearing for the cost claim (SC5): `get` sits on far
 * hotter paths than `search`, and the reason widening the binding is affordable
 * is that `annotateStaleness` returns BEFORE querying when a record declares no
 * refs. A test that only asserted the verdict would not distinguish "no
 * annotation because nothing matched" from "no annotation, but we paid for a
 * task-status query anyway."
 */
function serviceOver(
  row: ReturnType<typeof rowWith>,
  statuses: Record<string, string | undefined>
): { service: MemoryService; lookupCalls: () => number } {
  let lookupCalls = 0;
  const deps: MemoryServiceDeps = {
    db: dbReturning(row),
    vectorStorage: {} as VectorStorage,
    embeddingService: {} as EmbeddingService,
    taskStatusLookup: async (taskIds: string[]) => {
      lookupCalls++;
      return new Map(taskIds.map((id) => [id, statuses[id]]));
    },
  };
  return { service: new MemoryService(deps), lookupCalls: () => lookupCalls };
}

describe("MemoryService.getWithStaleness (mt#4743)", () => {
  // AT3 — the discrimination control. Both halves run the SAME code path over
  // the SAME record text; only the referenced task's status differs.
  describe("AT3: same path, opposite outcomes on task status alone", () => {
    test("a declared retirement clause whose task is CLOSED annotates STALE", async () => {
      const { service } = serviceOver(rowWith(DECLARES_RETIREMENT), { "mt#1541": "CLOSED" });

      const result = await service.getWithStaleness(UUID);

      expect(result?.record.id).toBe(UUID);
      expect(result?.staleness?.outcome).toBe("stale");
      expect(result?.staleness?.completedTasks).toEqual([{ taskId: "mt#1541", status: "CLOSED" }]);
    });

    test("the SAME record whose task is still OPEN does not annotate stale", async () => {
      const { service } = serviceOver(rowWith(DECLARES_RETIREMENT), { "mt#1541": "TODO" });

      const result = await service.getWithStaleness(UUID);

      expect(result?.record.id).toBe(UUID);
      expect(result?.staleness?.outcome).toBe("current");
      expect(result?.staleness?.completedTasks).toEqual([]);
    });
  });

  // SC4 — the negative control. A record whose refs are all still open, and a
  // record that declares no retirement relationship at all, must produce no
  // annotation. A trigger that fires on every family root is noise.
  describe("SC4: negative control", () => {
    test("a record naming a task WITHOUT a retirement relationship is unannotated", async () => {
      const { service } = serviceOver(rowWith(NAMES_NO_RETIREMENT), {
        "mt#1541": "CLOSED",
      });

      const result = await service.getWithStaleness(UUID);

      // The referenced task IS closed — so this asserts the EXTRACTOR declined,
      // not that the status lookup happened to come back open. That is the
      // discriminating form: a bare-mention record must not be flagged even
      // when the task it mentions is terminal.
      expect(result?.record.id).toBe(UUID);
      expect(result?.staleness).toBeUndefined();
    });

    test("SC5 cost: a record declaring no refs issues ZERO status queries", async () => {
      const { service, lookupCalls } = serviceOver(rowWith(NAMES_NO_RETIREMENT), {});

      await service.getWithStaleness(UUID);

      // This is the whole cost argument for binding the annotation to `get`:
      // the ~86% of records that declare no retirement relationship pay nothing.
      expect(lookupCalls()).toBe(0);
    });

    test("a record that DOES declare a clause issues exactly one status query", async () => {
      const { service, lookupCalls } = serviceOver(rowWith(DECLARES_RETIREMENT), {
        "mt#1541": "CLOSED",
      });

      await service.getWithStaleness(UUID);

      expect(lookupCalls()).toBe(1);
    });
  });

  // The structured channel takes precedence over the text scan, and it is how a
  // record reaches the annotator without any retirement prose at all.
  test("a tracksTask association annotates without any retirement prose", async () => {
    const { service } = serviceOver(rowWith("no clause here", { tracksTask: ["mt#1541"] }), {
      "mt#1541": "DONE",
    });

    const result = await service.getWithStaleness(UUID);

    expect(result?.staleness?.outcome).toBe("stale");
    expect(result?.staleness?.source).toBe("associations");
  });

  test("an unresolvable ref is 'unresolved', never a silent pass", async () => {
    // `undefined` status models a ref the task graph cannot account for. It must
    // not collapse into "we checked, nothing is stale" — the same `checked:false`
    // discipline the module docblock records.
    const { service } = serviceOver(rowWith(DECLARES_RETIREMENT), { "mt#1541": undefined });

    const result = await service.getWithStaleness(UUID);

    expect(result?.staleness?.outcome).toBe("unresolved");
    expect(result?.staleness?.unresolvedTasks).toEqual(["mt#1541"]);
  });

  test("a miss returns null rather than an unannotated shell", async () => {
    const deps: MemoryServiceDeps = {
      db: {
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
        insert: () => {
          throw new Error("not used");
        },
        update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
        delete: () => {
          throw new Error("not used");
        },
        transaction: async () => {
          throw new Error("not used");
        },
      } as unknown as MemoryServiceDb,
      vectorStorage: {} as VectorStorage,
      embeddingService: {} as EmbeddingService,
    };

    expect(await new MemoryService(deps).getWithStaleness(UUID)).toBeNull();
  });

  test("no taskStatusLookup dep configured degrades to an unannotated record", async () => {
    // Matches `annotateStaleness`'s existing early return. The record must still
    // come back — a missing optional dep is not an error path.
    const deps: MemoryServiceDeps = {
      db: dbReturning(rowWith(DECLARES_RETIREMENT)),
      vectorStorage: {} as VectorStorage,
      embeddingService: {} as EmbeddingService,
    };

    const result = await new MemoryService(deps).getWithStaleness(UUID);

    expect(result?.record.id).toBe(UUID);
    expect(result?.staleness).toBeUndefined();
  });
});
