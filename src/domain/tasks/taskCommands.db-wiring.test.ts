import { describe, it, expect } from "bun:test";
import { listTasksFromParams } from "./taskCommands";

describe("DB wiring for minsky backend", () => {
  it("should not fail with 'Backend not found' when backend=minsky (uses DB-aware factory)", async () => {
    let threw: any = null;
    try {
      await listTasksFromParams({ backend: "minsky", json: true } as any);
    } catch (err) {
      threw = err instanceof Error ? err : new Error(String(err));
    }

    // Must throw (no DB configured), but not with legacy wiring error
    expect(threw).toBeTruthy();
    expect(String(threw?.message || threw)).not.toMatch(/Backend not found/i);
    // Accept either explicit connection error or generic DB creation error
    expect(String(threw?.message || threw)).toMatch(/PostgreSQL|database/i);
  });
});
