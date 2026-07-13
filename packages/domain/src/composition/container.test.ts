/**
 * Tests for TsyringeContainer boot-tolerant deferral (mt#2349).
 *
 * A factory may fail at initialize() because a required resource (Postgres) is
 * unavailable. Such errors carry a structural `bootDeferrable` marker; the
 * container defers ONLY those to a throws-on-use placeholder so non-DB commands
 * boot, while every other factory error still aborts boot (fail-fast).
 */

import { describe, test, expect } from "bun:test";
import { TsyringeContainer } from "./container";

function bootDeferrableError(message: string): Error {
  const err = new Error(message) as Error & { bootDeferrable: boolean };
  err.bootDeferrable = true;
  return err;
}

describe("TsyringeContainer boot-tolerant deferral (mt#2349)", () => {
  test("a bootDeferrable factory failure does not abort initialize()", async () => {
    const c = new TsyringeContainer();
    c.register("a" as never, () => "ok" as never);
    c.register("b" as never, () => {
      throw bootDeferrableError("no postgres");
    });

    // initialize() must NOT throw — the deferrable failure is tolerated.
    await c.initialize();

    // The healthy service still resolves normally.
    expect(c.get("a" as never)).toBe("ok" as never);
    // The deferred service resolves to a placeholder (not the thrown error).
    expect(c.has("b" as never)).toBe(true);
  });

  test("a NON-bootDeferrable factory failure aborts initialize() (fail-fast)", async () => {
    const c = new TsyringeContainer();
    c.register("boom" as never, () => {
      throw new Error("genuine wiring bug");
    });

    await expect(c.initialize()).rejects.toThrow("genuine wiring bug");
  });

  describe("deferred-failure placeholder", () => {
    async function makePlaceholder(): Promise<Record<string, unknown>> {
      const c = new TsyringeContainer();
      c.register("svc" as never, () => {
        throw bootDeferrableError("PostgreSQL configuration required");
      });
      await c.initialize();
      return c.get("svc" as never) as Record<string, unknown>;
    }

    test("property READS are benign — they do not throw", async () => {
      const svc = await makePlaceholder();
      // Reading an arbitrary property returns a function (does not throw).
      expect(() => svc.capabilities).not.toThrow();
      expect(typeof svc.someArbitraryProp).toBe("function");
    });

    test("stringification is safe", async () => {
      const svc = await makePlaceholder();
      expect(() => String(svc)).not.toThrow();
      expect(String(svc)).toContain("unavailable service");
    });

    test("`in` / existence probes do not throw", async () => {
      const svc = await makePlaceholder();
      expect(() => "capabilities" in svc).not.toThrow();
    });

    test("CALLING a method throws the clear deferred-failure error", async () => {
      const svc = await makePlaceholder();
      expect(() => (svc.listSessions as () => unknown)()).toThrow(/unavailable/);
      expect(() => (svc.listSessions as () => unknown)()).toThrow(
        /PostgreSQL configuration required/
      );
    });
  });
});
