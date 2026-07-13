/**
 * emitSystemEventBestEffort tests (mt#2489) — the best-effort / non-fatal
 * safety contract: it must NEVER throw and must no-op gracefully when there is
 * no SQL-capable persistence. The happy-path emit is exercised by the
 * DrizzleEventEmitter tests and live verification (CLI emit → /api/activity).
 */
import { describe, test, expect, mock } from "bun:test";
import { emitSystemEventBestEffort } from "./system-event-emit";

const event = { eventType: "memory.created" as const, payload: { memoryId: "m1" } };

describe("emitSystemEventBestEffort (mt#2489)", () => {
  test("undefined container → no-op, does not throw", async () => {
    await expect(emitSystemEventBestEffort(undefined, event)).resolves.toBeUndefined();
  });

  test("container without 'persistence' → no-op, never calls get", async () => {
    const get = mock(() => undefined);
    const container = { has: () => false, get };
    await emitSystemEventBestEffort(container, event);
    expect(get).not.toHaveBeenCalled();
  });

  test("persistence that is not a PersistenceProvider → no-op (instanceof fails), no throw", async () => {
    // A plain object is not `instanceof PersistenceProvider`.
    const container = { has: () => true, get: () => ({ capabilities: { sql: true } }) };
    await expect(emitSystemEventBestEffort(container, event)).resolves.toBeUndefined();
  });

  test("a throwing container.get is swallowed (best-effort contract)", async () => {
    const container = {
      has: () => true,
      get: () => {
        throw new Error("boom");
      },
    };
    await expect(emitSystemEventBestEffort(container, event)).resolves.toBeUndefined();
  });
});
