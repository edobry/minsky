/**
 * emitSystemEventFromProvider tests (mt#2537) — the best-effort / non-fatal
 * safety contract: it must NEVER throw and must no-op gracefully when there is
 * no SQL-capable persistence provider. Mirrors
 * `system-event-emit.test.ts` (mt#2489), adapted for the directly-held
 * PersistenceProvider seam (`changeset.created` at `session_pr_create`).
 */
import { describe, test, expect, mock } from "bun:test";
import { emitSystemEventFromProvider } from "./emit-best-effort";

const event = {
  eventType: "changeset.created" as const,
  payload: { prNumber: 123 },
};

describe("emitSystemEventFromProvider (mt#2537)", () => {
  test("undefined persistenceProvider → no-op (returns false), does not throw", async () => {
    await expect(emitSystemEventFromProvider(undefined, event)).resolves.toBe(false);
  });

  test("provider without getDatabaseConnection → no-op (returns false), no throw", async () => {
    const provider = {} as any;
    await expect(emitSystemEventFromProvider(provider, event)).resolves.toBe(false);
  });

  test("getDatabaseConnection resolving to null → no-op (returns false), no throw", async () => {
    const provider = {
      getDatabaseConnection: async () => null,
    } as any;
    await expect(emitSystemEventFromProvider(provider, event)).resolves.toBe(false);
  });

  test("a throwing getDatabaseConnection is swallowed (best-effort contract, returns false)", async () => {
    const provider = {
      getDatabaseConnection: async () => {
        throw new Error("boom");
      },
    } as any;
    await expect(emitSystemEventFromProvider(provider, event)).resolves.toBe(false);
  });

  test("SQL-capable provider with a live db → emits via DrizzleEventEmitter, returns true", async () => {
    const insertValues = mock(() => Promise.resolve());
    const fakeDb = {
      insert: () => ({ values: insertValues }),
    } as any;
    const provider = {
      getDatabaseConnection: async () => fakeDb,
    } as any;
    await expect(emitSystemEventFromProvider(provider, event)).resolves.toBe(true);
    expect(insertValues).toHaveBeenCalledTimes(1);
  });

  test("a rejecting insert is swallowed and returns false", async () => {
    const fakeDb = {
      insert: () => ({ values: () => Promise.reject(new Error("db down")) }),
    } as any;
    const provider = {
      getDatabaseConnection: async () => fakeDb,
    } as any;
    await expect(emitSystemEventFromProvider(provider, event)).resolves.toBe(false);
  });
});
