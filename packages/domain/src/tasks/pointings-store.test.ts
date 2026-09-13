import { describe, expect, test } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { declarePointing } from "./pointings-store";

/**
 * A minimal fake of the two drizzle chains `declarePointing` uses: the
 * pre-check `select().from().where().limit()` and the `insert().values()
 * .returning()`. Built by hand and passed in — a dependency, not a patch
 * (ADR-036) — so the unique-violation branch can be reached without a race.
 */
function fakeDb(opts: { clash: boolean; insertError?: unknown }): PostgresJsDatabase {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => (opts.clash ? [{ id: "existing" }] : []),
  };
  const insertChain = {
    values: () => insertChain,
    returning: async () => {
      if (opts.insertError !== undefined) throw opts.insertError;
      return [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "n",
          query: { tags: ["t"] },
          autonomyClass: "pull-only",
          wipLimit: 1,
          projectId: null,
          createdAt: new Date("2026-09-13T09:00:00Z"),
          archivedAt: null,
        },
      ];
    },
  };
  return { select: () => selectChain, insert: () => insertChain } as unknown as PostgresJsDatabase;
}

const input = { name: "n", query: { tags: ["t"] }, projectScope: "allProjects" as const };

describe("declarePointing — the name-uniqueness race", () => {
  test("a unique violation raised by the insert maps to the name-taken outcome, not a throw", async () => {
    const db = fakeDb({
      clash: false,
      insertError: Object.assign(new Error("dup"), { code: "23505" }),
    });
    const out = await declarePointing(db, input);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("name-taken");
  });

  test("the code is also read off the error's cause (postgres-js wraps the driver error)", async () => {
    const wrapped = Object.assign(new Error("insert failed"), { cause: { code: "23505" } });
    const out = await declarePointing(fakeDb({ clash: false, insertError: wrapped }), input);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("name-taken");
  });

  test("any other insert error is rethrown", async () => {
    const db = fakeDb({
      clash: false,
      insertError: Object.assign(new Error("boom"), { code: "57P01" }),
    });
    await expect(declarePointing(db, input)).rejects.toThrow("boom");
  });

  test("the pre-check still fast-paths a visible clash without inserting", async () => {
    const out = await declarePointing(
      fakeDb({ clash: true, insertError: new Error("must not insert") }),
      input
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("name-taken");
  });

  test("a clean insert returns the record", async () => {
    const out = await declarePointing(fakeDb({ clash: false }), input);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.pointing.name).toBe("n");
  });
});
