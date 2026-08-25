/**
 * Tests for resolveTranscriptProjectScope — the ADR-021/mt#2416-style
 * CLI/stdio-MCP project-scope resolver wired into `transcripts.search` /
 * `transcripts.similar` (mt#2417, Phase 1.4).
 *
 * @see PR #2065 R1 (BLOCKING 2) — the `--all-projects` flag was declared on
 *   both commands' param maps, but this resolver (the thing that actually
 *   makes the flag do something) had no test coverage of its own. This file
 *   closes that gap.
 */

import { describe, test, expect } from "bun:test";
import { PersistenceProvider } from "@minsky/domain/persistence/types";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { resolveTranscriptProjectScope } from "./resolve-transcript-project-scope";

const FAKE_PROJECT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/**
 * A db handle whose `select` is a PROTOTYPE method, matching drizzle's real shape.
 *
 * The prototype placement is load-bearing, not incidental (mt#4509). This fake used to
 * return an object LITERAL, so `select` was an own enumerable property — and the resolver
 * under test copied the handle with an object rest-spread, which preserves own properties
 * and silently drops prototype methods. The literal survived that copy; a real
 * `PostgresJsDatabase` did not. So this test passed for two months while every production
 * call threw `db.select is not a function`.
 *
 * A fake that differs from the real value in exactly the dimension under test cannot fail.
 * `keeps select off the instance` below pins the shape so it cannot drift back to a literal.
 */
class PrototypeMethodDb {
  select() {
    return {
      from(_table: unknown) {
        return {
          where(_cond: unknown) {
            return {
              limit(_n: number) {
                return Promise.resolve([{ id: FAKE_PROJECT_ID, slug: "fake/project" }]);
              },
            };
          },
        };
      },
    };
  }
}

/**
 * Minimal SQL-capable PersistenceProvider fake. `getDatabaseConnection()`
 * returns a {@link PrototypeMethodDb} — a fluent `.select().from().where().limit()` stub
 * that resolves to a single project row regardless of the query's WHERE condition. This
 * test only needs to prove the resolver's happy-path plumbing (identity
 * resolved -> DB queried -> uuid returned), not the slug-matching logic
 * itself (that's `resolveProjectScope`'s own contract, already covered by
 * `packages/domain/src/project/scope-resolver.ts`'s tests).
 */
class FakeSqlPersistenceProvider extends PersistenceProvider {
  readonly capabilities = {
    sql: true as const,
    vectorStorage: false as const,
    transactions: true as const,
    jsonb: true as const,
    migrations: true as const,
  };
  getCapabilities() {
    return this.capabilities;
  }
  async initialize() {}
  async close() {}
  getConnectionInfo() {
    return "fake-sql-provider";
  }
  async getDatabaseConnection() {
    return new PrototypeMethodDb() as unknown as ReturnType<
      NonNullable<PersistenceProvider["getDatabaseConnection"]>
    > extends Promise<infer T>
      ? T
      : never;
  }
}

/** PersistenceProvider fake whose capabilities.sql is false. */
class NoSqlPersistenceProvider extends PersistenceProvider {
  readonly capabilities = {
    sql: false as const,
    vectorStorage: false as const,
    transactions: false as const,
    jsonb: false as const,
    migrations: false as const,
  };
  getCapabilities() {
    return this.capabilities;
  }
  async initialize() {}
  async close() {}
  getConnectionInfo() {
    return "no-sql-provider";
  }
}

function makeContainer(
  persistence: unknown,
  bound = true
): Pick<AppContainerInterface, "has" | "get"> {
  return {
    has: (key: string) => bound && key === "persistence",

    // AppContainerInterface.get<K> is generic over the real service map; this fake
    // only ever needs to hand back the one `persistence` fake object under test.
    get: ((key: string): any => {
      if (bound && key === "persistence") return persistence;
      throw new Error(`not bound: ${key}`);
    }) as AppContainerInterface["get"],
  };
}

describe("resolveTranscriptProjectScope", () => {
  test("the db fake keeps select off the instance, as drizzle does", () => {
    // Pins the one property of the fake this file's coverage actually depends on (mt#4509).
    // Without it, a well-meaning simplification back to an object literal restores the blind
    // spot that let a two-month production defect pass every run of the suite below.
    const db = new PrototypeMethodDb();
    expect(typeof db.select).toBe("function");
    expect(Object.prototype.hasOwnProperty.call(db, "select")).toBe(false);
    expect(typeof ({ ...db } as { select?: unknown }).select).toBe("undefined");
  });

  test("allProjects=true always returns undefined, regardless of container state", async () => {
    const container = makeContainer(new FakeSqlPersistenceProvider());
    const result = await resolveTranscriptProjectScope(true, {
      container: container as AppContainerInterface,
    });
    expect(result).toBeUndefined();
  });

  test("no persistence bound in container returns undefined (fail-open)", async () => {
    const container = makeContainer(undefined, false);
    const result = await resolveTranscriptProjectScope(undefined, {
      container: container as AppContainerInterface,
    });
    expect(result).toBeUndefined();
  });

  test("no container at all returns undefined (fail-open)", async () => {
    const result = await resolveTranscriptProjectScope(undefined, {});
    expect(result).toBeUndefined();
  });

  test("persistence without sql capability returns undefined (fail-open)", async () => {
    const container = makeContainer(new NoSqlPersistenceProvider());
    const result = await resolveTranscriptProjectScope(undefined, {
      container: container as AppContainerInterface,
    });
    expect(result).toBeUndefined();
  });

  test("persistence that is not a PersistenceProvider instance returns undefined (fail-open)", async () => {
    const container = makeContainer({ capabilities: { sql: true } });
    const result = await resolveTranscriptProjectScope(undefined, {
      container: container as AppContainerInterface,
    });
    expect(result).toBeUndefined();
  });

  test("resolves a project uuid when SQL-capable persistence is present and identity resolves", async () => {
    // Exercises the real resolveProjectIdentity()/resolveProjectScope() path
    // against the actual test-process cwd (the session workspace, a real git
    // repo with an origin remote) -- proving the resolver's full happy-path
    // wiring end to end, not just its early-exit guards.
    const container = makeContainer(new FakeSqlPersistenceProvider());
    const result = await resolveTranscriptProjectScope(undefined, {
      container: container as AppContainerInterface,
    });
    expect(result).toBe(FAKE_PROJECT_ID);
  });

  test("allProjects=false behaves the same as omitted (still resolves)", async () => {
    const container = makeContainer(new FakeSqlPersistenceProvider());
    const result = await resolveTranscriptProjectScope(false, {
      container: container as AppContainerInterface,
    });
    expect(result).toBe(FAKE_PROJECT_ID);
  });
});
