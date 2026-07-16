/**
 * Tests for the DrizzleSessionRepository + createSessionProvider factory.
 *
 * The repository's SQL behavior (filters, ordering, pagination, CRUD) is
 * covered behaviorally by the FakeSessionProvider-backed session tests (the
 * SessionProviderInterface contract) and end-to-end by the real-Postgres
 * smoke script (`scripts/smoke-session-crud.ts`). These unit tests cover the
 * factory wiring + the connection-independent methods, which need no DB.
 */
import { describe, test, expect, mock } from "bun:test";
import {
  createSessionProvider,
  DrizzleSessionRepository,
  type CreateSessionProviderDeps,
} from "./drizzle-session-repository";
import type { PersistenceProvider } from "../persistence/types";

// Minimal stub for the PostgresJsDatabase handle. The factory only stores it
// on the repository; no query methods are invoked in these tests.
const stubDb = {} as never;

function makeProvider(): PersistenceProvider {
  return {
    getDatabaseConnection: mock(() => Promise.resolve(stubDb)),
  } as unknown as PersistenceProvider;
}

describe("createSessionProvider", () => {
  test("throws when no persistence dependency is provided", async () => {
    // eslint-disable-next-line custom/no-unwaited-async-factory -- rejection test: expect().rejects awaits the promise
    await expect(createSessionProvider()).rejects.toThrow(
      "Session provider unavailable: no persistence dependency provided"
    );
  });

  test("throws when the provider yields no database connection", async () => {
    const provider = {
      getDatabaseConnection: mock(() => Promise.resolve(null)),
    } as unknown as PersistenceProvider;
    // eslint-disable-next-line custom/no-unwaited-async-factory -- rejection test: expect().rejects awaits the promise
    await expect(createSessionProvider(undefined, provider)).rejects.toThrow(
      "returned no database connection"
    );
  });

  test("returns an auto-repair-wrapped provider exposing the full interface (raw provider)", async () => {
    const provider = makeProvider();
    const sessionProvider = await createSessionProvider(undefined, provider);

    expect(sessionProvider.constructor.name).toBe("SessionAutoRepairProvider");
    expect(typeof sessionProvider.listSessions).toBe("function");
    expect(typeof sessionProvider.getSession).toBe("function");
    expect(typeof sessionProvider.getSessionByTaskId).toBe("function");
    expect(typeof sessionProvider.addSession).toBe("function");
    expect(typeof sessionProvider.updateSession).toBe("function");
    expect(typeof sessionProvider.deleteSession).toBe("function");
    expect(typeof sessionProvider.getRepoPath).toBe("function");
    expect(typeof sessionProvider.getSessionWorkdir).toBe("function");
  });

  test("accepts the legacy CreateSessionProviderDeps wrapper", async () => {
    const provider = makeProvider();
    const deps: CreateSessionProviderDeps = {
      persistenceService: { isInitialized: () => true, getProvider: () => provider },
    };
    const sessionProvider = await createSessionProvider(undefined, deps);
    expect(sessionProvider.constructor.name).toBe("SessionAutoRepairProvider");
  });
});

describe("DrizzleSessionRepository", () => {
  test("implements the full SessionProviderInterface surface", () => {
    const repo = new DrizzleSessionRepository(stubDb);
    for (const method of [
      "listSessions",
      "getSession",
      "getSessionByTaskId",
      "addSession",
      "updateSession",
      "deleteSession",
      "getRepoPath",
      "getSessionWorkdir",
    ]) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  test("getRepoPath returns the record's repoPath when present", async () => {
    const repo = new DrizzleSessionRepository(stubDb);
    const path = await repo.getRepoPath({
      sessionId: "s1",
      repoPath: "/explicit/path",
    } as never);
    expect(path).toBe("/explicit/path");
  });

  test("getRepoPath derives <stateDir>/sessions/<id> when repoPath is absent", async () => {
    const repo = new DrizzleSessionRepository(stubDb);
    const path = await repo.getRepoPath({ sessionId: "s1" } as never);
    expect(path.endsWith("/sessions/s1")).toBe(true);
  });

  describe("deleteSession attachment teardown (mt#2284)", () => {
    /**
     * Chainable fake DB supporting `.delete(table).where(...).returning(...)`
     * for BOTH the `sessions` table (the deletion itself) and the
     * `presence_claims` table (the attachment-teardown call this test pins).
     * Each `.delete()` invocation is recorded so the test can assert exactly
     * how many delete statements ran without needing table-identity plumbing.
     */
    function makeFakeDb(sessionRowsReturned: Array<{ sessionId: string }>) {
      const deleteCalls: unknown[] = [];
      const db = {
        delete: mock((table: unknown) => {
          deleteCalls.push(table);
          return {
            where: () => ({
              returning: () => Promise.resolve(sessionRowsReturned),
            }),
          };
        }),
      };
      return { db, deleteCalls };
    }

    test("clears session attachment records after a successful deletion", async () => {
      const { db, deleteCalls } = makeFakeDb([{ sessionId: "s1" }]);
      const repo = new DrizzleSessionRepository(db as never);

      const deleted = await repo.deleteSession("s1");

      expect(deleted).toBe(true);
      // One delete for the sessions row itself, one for the attachment teardown.
      expect(deleteCalls.length).toBe(2);
    });

    test("does NOT attempt attachment teardown when the session was not found", async () => {
      const { db, deleteCalls } = makeFakeDb([]); // no rows returned => deleted === false
      const repo = new DrizzleSessionRepository(db as never);

      const deleted = await repo.deleteSession("missing-session");

      expect(deleted).toBe(false);
      // Only the (no-op) sessions delete attempt — no attachment teardown fired.
      expect(deleteCalls.length).toBe(1);
    });

    test("attachment teardown failure does not fail the session deletion (best-effort)", async () => {
      const deleteCalls: unknown[] = [];
      const db = {
        delete: mock((table: unknown) => {
          deleteCalls.push(table);
          if (deleteCalls.length === 1) {
            // First call: the sessions-table delete succeeds normally.
            return { where: () => ({ returning: () => Promise.resolve([{ sessionId: "s1" }]) }) };
          }
          // Second call: the attachment-teardown delete throws.
          throw new Error("boom");
        }),
      };
      const repo = new DrizzleSessionRepository(db as never);

      const deleted = await repo.deleteSession("s1");

      // The session deletion itself still reports success despite the
      // teardown failure — attachment tracking is best-effort.
      expect(deleted).toBe(true);
    });
  });
});
