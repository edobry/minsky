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

    // mt#2945 regression: `service.constructor.name` — the diagnostic idiom
    // `session-context-resolver.ts` uses to log the resolved provider's type
    // — previously threw a raw "undefined is not an object (evaluating
    // '...constructor.name')" TypeError, because `constructor` used to be
    // grouped with `then`/symbols and return `undefined`. That crashed
    // session_pr_* MCP tools whenever `sessionProvider` resolved to this
    // placeholder after a reload (e.g. a transient Postgres hiccup right at
    // container-init time), before the placeholder's own clear error could
    // ever fire.
    test("`.constructor.name` is a safe, informative read (mt#2945)", async () => {
      const svc = await makePlaceholder();
      expect(() => (svc.constructor as { name: string }).name).not.toThrow();
      expect((svc.constructor as { name: string }).name).toBe("UnavailablePlaceholder_svc");
    });

    test("the deferred-failure error names the restart/reconnect recovery path (mt#2945)", async () => {
      const svc = await makePlaceholder();
      expect(() => (svc.listSessions as () => unknown)()).toThrow(/restart this process/);
      expect(() => (svc.listSessions as () => unknown)()).toThrow(/\/mcp/);
    });
  });

  // mt#2945: a deferred-failure placeholder should self-heal on a LATER get()
  // call once the underlying resource recovers, instead of staying wedged
  // for the rest of the process's life (the only recovery path previously
  // available was a full restart / MCP reconnect).
  describe("self-recovery on later get() (mt#2945)", () => {
    test("a service that fails once then succeeds resolves to the real instance on a later get()", async () => {
      const c = new TsyringeContainer();
      let attempts = 0;
      c.register("flaky" as never, () => {
        attempts += 1;
        if (attempts === 1) {
          throw bootDeferrableError("transient outage");
        }
        return "recovered" as never;
      });

      await c.initialize();

      // First get(): still the placeholder (factory hasn't been retried yet).
      const first = c.get("flaky" as never) as unknown as Record<string, unknown>;
      expect(() => (first.anything as () => unknown)()).toThrow(/unavailable/);

      // get() kicked off a background retry; wait for it to settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A subsequent get() returns the now-healthy real instance.
      expect(c.get("flaky" as never)).toBe("recovered" as never);
    });

    test("a service that keeps failing stays a placeholder across repeated get() calls", async () => {
      const c = new TsyringeContainer();
      c.register("alwaysDown" as never, () => {
        throw bootDeferrableError("still down");
      });

      await c.initialize();

      c.get("alwaysDown" as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const svc = c.get("alwaysDown" as never) as unknown as Record<string, unknown>;
      expect(() => (svc.anything as () => unknown)()).toThrow(/unavailable/);
      expect(() => (svc.anything as () => unknown)()).toThrow(/still down/);
    });
  });
});
