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
// Imported for the drift guard only (PR #2603 R1): container.ts detects a
// degraded substitute STRUCTURALLY and deliberately does not import this class,
// so these tests are what pin the two definitions together.
import { UnconfiguredPersistenceProvider } from "../persistence/unconfigured-provider";

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
    // deferred-failure placeholder after a reload (a transient Postgres hiccup
    // at container-init time), before the placeholder's own clear error could
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

    // mt#2945 PR #2113 R1 review: nested property chains must stay benign to
    // read at arbitrary depth (not just one level), and calling ANY node in
    // the chain must still throw the clear deferred-failure error.
    describe("nested benign reads (mt#2945 R1)", () => {
      test("reading a property OFF a property read does not throw", async () => {
        const svc = await makePlaceholder();
        expect(() => (svc.capabilities as Record<string, unknown>).vectorStorage).not.toThrow();
        expect(typeof (svc.capabilities as Record<string, unknown>).vectorStorage).toBe("function");
      });

      test("Object.keys() on the placeholder does not throw", async () => {
        const svc = await makePlaceholder();
        expect(() => Object.keys(svc)).not.toThrow();
      });

      test("calling a NESTED node throws the same clear deferred-failure error", async () => {
        const svc = await makePlaceholder();
        const nested = (svc.capabilities as Record<string, unknown>).vectorStorage as () => unknown;
        expect(() => nested()).toThrow(/unavailable/);
        expect(() => nested()).toThrow(/PostgreSQL configuration required/);
      });
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

    // mt#2945 PR #2113 R2 review: a manual set() override must never be
    // clobbered by the background retry — including a retry that was ALREADY
    // in flight when set() was called.
    test("set() on a deferred key wins over an in-flight background retry (mt#2945 R2)", async () => {
      const c = new TsyringeContainer();
      let attempts = 0;
      c.register("overridable" as never, () => {
        attempts += 1;
        if (attempts === 1) {
          throw bootDeferrableError("transient outage");
        }
        return "factory-recovered" as never;
      });

      await c.initialize();

      // First get() kicks off the background retry (still in flight when
      // this call returns — the retry's factory call hasn't settled yet).
      c.get("overridable" as never);

      // A caller manually overrides the key WHILE that retry is in flight.
      c.set("overridable" as never, "manual-override" as never);

      // Let the in-flight retry's factory-call promise settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The manual override wins — the retry's "factory-recovered" result
      // must NOT have clobbered it.
      expect(c.get("overridable" as never)).toBe("manual-override" as never);
    });

    test("set() on a deferred key stops FUTURE get() calls from retrying at all", async () => {
      const c = new TsyringeContainer();
      let factoryCalls = 0;
      c.register("neverRetryAgain" as never, () => {
        factoryCalls += 1;
        throw bootDeferrableError("down");
      });

      await c.initialize();
      expect(factoryCalls).toBe(1); // the initial initialize() attempt

      c.set("neverRetryAgain" as never, "manual-override" as never);

      // Repeated get() calls must not trigger any further factory calls —
      // set() should have cleared the key out of deferredKeys entirely.
      c.get("neverRetryAgain" as never);
      c.get("neverRetryAgain" as never);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(factoryCalls).toBe(1);
      expect(c.get("neverRetryAgain" as never)).toBe("manual-override" as never);
    });
  });

  // mt#3635 / ADR-035 rule 1: the self-heal above only ever fired for a factory
  // that THREW. A composition root that CONVERTS a failed initialization into a
  // substitute value resolves "successfully", so its key was never enrolled —
  // which is why the persistence provider stayed degraded for the life of the
  // process while this very mechanism sat unreachable one branch away.
  describe("retry for a substitute that was RETURNED, not thrown (mt#3635)", () => {
    /** The value a recovered factory returns; stands in for a live provider. */
    const HEALTHY = "healthy-provider";

    /** Minimal structural stand-in for UnconfiguredPersistenceProvider. */
    function makeSubstitute(degraded = true): {
      degradedSubstitute: boolean;
      attempts: Array<{ at: Date; error: string }>;
      noteRetryAttempt(at: Date, error: string): void;
    } {
      const attempts: Array<{ at: Date; error: string }> = [];
      return {
        degradedSubstitute: degraded,
        attempts,
        noteRetryAttempt(at: Date, error: string) {
          attempts.push({ at, error });
        },
      };
    }

    /** Let the fire-and-forget retry / re-resolution promises settle. */
    async function settle(): Promise<void> {
      for (let i = 0; i < 6; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    test("a factory that RETURNS a degraded substitute is retried and recovers", async () => {
      const c = new TsyringeContainer();
      let calls = 0;
      const substitute = makeSubstitute();
      c.register("persistence" as never, () => {
        calls += 1;
        return (calls === 1 ? substitute : HEALTHY) as never;
      });

      await c.initialize();

      // initialize() kept the substitute REGISTERED (not swapped for the
      // throws-on-access placeholder) so diagnostic surfaces keep answering.
      expect(calls).toBe(1);
      expect(c.get("persistence" as never)).toBe(substitute as never);

      await settle();

      expect(c.get("persistence" as never)).toBe(HEALTHY as never);
    });

    test("a substitute marked degradedSubstitute:false is NOT enrolled for retry", async () => {
      // The deliberately-unconfigured local/dev boot path (ADR-035 rule 3):
      // nothing has failed, so retrying would churn forever on a laptop with
      // no database.
      const c = new TsyringeContainer();
      let calls = 0;
      c.register("persistence" as never, () => {
        calls += 1;
        return makeSubstitute(false) as never;
      });

      await c.initialize();
      c.get("persistence" as never);
      c.get("persistence" as never);
      await settle();

      expect(calls).toBe(1);
    });

    test("repeated get() calls do not retry faster than the backoff floor", async () => {
      const c = new TsyringeContainer();
      let calls = 0;
      c.register("persistence" as never, () => {
        calls += 1;
        return makeSubstitute() as never;
      });

      await c.initialize();
      expect(calls).toBe(1);

      // First get() is eligible (no attempt has run yet) and consumes the slot.
      c.get("persistence" as never);
      await settle();
      expect(calls).toBe(2);

      // Every further get() in the same instant is inside the floor. Without
      // the gate this loop would issue 25 more re-init attempts.
      for (let i = 0; i < 25; i += 1) c.get("persistence" as never);
      await settle();
      expect(calls).toBe(2);
    });

    test("a retry that returns another degraded substitute records the attempt", async () => {
      const c = new TsyringeContainer();
      const first = makeSubstitute();
      const second = makeSubstitute();
      let calls = 0;
      c.register("persistence" as never, () => {
        calls += 1;
        return (calls === 1 ? first : second) as never;
      });

      await c.initialize();
      c.get("persistence" as never);
      await settle();

      // The attempt is recorded so `persistence_check` and `/health` can tell
      // "stuck since boot" from "retried and still failing" (ADR-035 rule 4).
      expect(second.attempts.length).toBe(1);
      expect(c.get("persistence" as never)).toBe(second as never);
    });

    test("dependents registered after the recovered key are rebuilt", async () => {
      // The criterion this test exists for: initialize() memoizes every key with
      // useValue, so a dependent that captured the degraded substitute keeps
      // serving it forever. Swapping only the provider restores nothing.
      const c = new TsyringeContainer();
      let persistenceCalls = 0;
      const substitute = makeSubstitute();
      c.register("persistence" as never, () => {
        persistenceCalls += 1;
        return (persistenceCalls === 1 ? substitute : HEALTHY) as never;
      });
      c.register("taskService" as never, (inner) => {
        const provider = inner.get("persistence" as never) as unknown;
        return {
          backends: provider === (HEALTHY as unknown) ? ["mt"] : [],
        } as never;
      });

      await c.initialize();

      // Built against the degraded provider: no backends, the shape that makes
      // an existing task read as "not found".
      expect((c.get("taskService" as never) as { backends: string[] }).backends).toEqual([]);

      c.get("persistence" as never);
      await settle();

      expect((c.get("taskService" as never) as { backends: string[] }).backends).toEqual(["mt"]);
    });

    // PR #2603 R1, BLOCKING: both the retry and the dependent rebuild register
    // an instance AFTER awaiting a factory, and neither coordinated with
    // teardown — a task that settled after close() would re-register onto a
    // container whose tsyringe had already been reset.
    test("close() during an in-flight rebuild does not resurrect a dependent", async () => {
      const c = new TsyringeContainer();
      let persistenceCalls = 0;
      c.register("persistence" as never, () => {
        persistenceCalls += 1;
        return (persistenceCalls === 1 ? makeSubstitute() : HEALTHY) as never;
      });
      // Rebuilt only via the post-recovery path, and slowly enough that close()
      // lands while its factory is still awaiting.
      let dependentBuilds = 0;
      c.register("taskService" as never, async () => {
        dependentBuilds += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return `built-${dependentBuilds}` as never;
      });

      await c.initialize();
      expect(dependentBuilds).toBe(1);

      c.get("persistence" as never);
      // Close while the recovery-triggered rebuild is mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await c.close();
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The rebuild ran, but its result must NOT have been registered onto the
      // torn-down container.
      expect(c.has("taskService" as never)).toBe(false);
    });

    // PR #2603 R1: the in-flight claim is now taken BEFORE the backoff gate, so
    // the gate's early return has to release it. Holding it would wedge the key
    // in-flight forever and stop it retrying at all — a worse failure than the
    // storm the gate prevents.
    test("a backoff-blocked attempt releases the in-flight claim", async () => {
      const c = new TsyringeContainer();
      let calls = 0;
      c.register("persistence" as never, () => {
        calls += 1;
        return makeSubstitute() as never;
      });

      await c.initialize();
      c.get("persistence" as never); // consumes the first slot
      await settle();
      expect(calls).toBe(2);

      // Blocked by the floor — must not leave the key claimed.
      c.get("persistence" as never);
      await settle();
      expect(calls).toBe(2);

      // With the claim leaked, this attempt could never run again even once the
      // floor elapsed. Simulate the floor elapsing rather than sleeping 10s.
      const state = (
        c as unknown as {
          retryState: Map<string, { lastAttemptAtMs: number | null; delayMs: number }>;
        }
      ).retryState.get("persistence");
      expect(state).toBeDefined();
      // Epoch 0 is unambiguously outside any backoff window, so the gate lets
      // the next attempt through — no wall-clock arithmetic needed.
      if (state) state.lastAttemptAtMs = 0;

      c.get("persistence" as never);
      await settle();
      expect(calls).toBe(3);
    });

    // PR #2603 R1, NON-BLOCKING: container.ts checks the degraded-substitute
    // shape structurally rather than importing the persistence class, so the
    // two definitions could drift apart silently. Pin the real class against
    // the container's guard so a rename on either side fails here.
    test("the container enrolls a REAL UnconfiguredPersistenceProvider", async () => {
      const c = new TsyringeContainer();
      let calls = 0;
      c.register("persistence" as never, () => {
        calls += 1;
        return (
          calls === 1 ? new UnconfiguredPersistenceProvider("getaddrinfo ENOTFOUND", true) : HEALTHY
        ) as never;
      });

      await c.initialize();
      expect(calls).toBe(1);

      // The get() is what arms the retry — settling alone would prove nothing.
      c.get("persistence" as never);
      await settle();

      expect(c.get("persistence" as never)).toBe(HEALTHY as never);
    });

    // The mirror of the above: the deliberately-unconfigured provider carries
    // the same class but must NOT be enrolled (ADR-035 rule 3).
    test("a REAL unconfigured (not failed) provider is not enrolled", async () => {
      const c = new TsyringeContainer();
      let calls = 0;
      c.register("persistence" as never, () => {
        calls += 1;
        return new UnconfiguredPersistenceProvider("no connection string", false) as never;
      });

      await c.initialize();
      c.get("persistence" as never);
      c.get("persistence" as never);
      await settle();

      expect(calls).toBe(1);
    });

    test("a manually overridden dependent is not clobbered by the rebuild", async () => {
      const c = new TsyringeContainer();
      let persistenceCalls = 0;
      c.register("persistence" as never, () => {
        persistenceCalls += 1;
        return (persistenceCalls === 1 ? makeSubstitute() : HEALTHY) as never;
      });
      c.register("taskService" as never, () => "factory-built" as never);

      await c.initialize();
      c.set("taskService" as never, "manual-override" as never);

      c.get("persistence" as never);
      await settle();

      expect(c.get("taskService" as never)).toBe("manual-override" as never);
    });
  });
});
