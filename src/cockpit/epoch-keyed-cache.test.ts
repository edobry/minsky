/**
 * `createEpochKeyedCache` — the primitive that makes the persistence-epoch
 * contract hold by construction (mt#3721).
 *
 * Every test here is a negative control by construction: each asserts the
 * behavior that was ABSENT before mt#3721, and each fails against the previous
 * unconditional `if (_cached) return _cached;` shape (verified by reverting the
 * helper to that shape — see the PR body's negative-control section).
 *
 * The `getEpoch` seam is used throughout rather than driving a real recycle:
 * the behavior under test is "what does the cache do when the epoch moves",
 * which is fully determined by that number. Driving a live pool recycle to
 * produce it would test `shared-persistence`'s recycle trigger instead, which
 * `shared-persistence.test.ts` already owns.
 */

import { describe, test, expect } from "bun:test";
import { createEpochKeyedCache } from "./shared-persistence";

describe("createEpochKeyedCache (mt#3721)", () => {
  test("serves the same instance for repeat calls within one epoch", async () => {
    let builds = 0;
    const get = createEpochKeyedCache(async () => ({ id: ++builds }), { getEpoch: () => 7 });

    const first = await get();
    const second = await get();

    expect(first).toBe(second);
    expect(builds).toBe(1);
  });

  test("re-resolves after the epoch moves, and does not return the stale value", async () => {
    let builds = 0;
    let epoch = 1;
    const get = createEpochKeyedCache(async () => ({ id: ++builds }), { getEpoch: () => epoch });

    const beforeRecycle = await get();
    expect(beforeRecycle.id).toBe(1);

    // A pool recycle bumps the epoch. This is the exact moment the pre-mt#3721
    // caches kept serving a handle to the ENDED pool.
    epoch = 2;

    const afterRecycle = await get();
    expect(afterRecycle.id).toBe(2);
    expect(afterRecycle).not.toBe(beforeRecycle);
  });

  test("caches the new value after a recycle rather than rebuilding every call", async () => {
    let builds = 0;
    let epoch = 1;
    const get = createEpochKeyedCache(async () => ({ id: ++builds }), { getEpoch: () => epoch });

    await get();
    epoch = 2;
    const a = await get();
    const b = await get();

    expect(a).toBe(b);
    expect(builds).toBe(2);
  });

  test("does NOT cache a null result — the next call retries", async () => {
    // ADR-035 rule 1: registering a substitute value for a failed
    // initialization without arming the retry is what made the reviewer widget
    // render placeholder zeros for the process lifetime. Successes-only caching
    // arms that retry implicitly.
    const results: Array<string | null> = [null, null, "live"];
    let calls = 0;
    const get = createEpochKeyedCache(async () => results[calls++] ?? null, {
      getEpoch: () => 1,
    });

    expect(await get()).toBeNull();
    expect(await get()).toBeNull();
    expect(await get()).toBe("live");
    expect(calls).toBe(3);

    // Once a real value is obtained it IS cached — the retry stops.
    expect(await get()).toBe("live");
    expect(calls).toBe(3);
  });

  test("a throwing resolver caches nothing and propagates", async () => {
    let calls = 0;
    const get = createEpochKeyedCache(
      async () => {
        calls++;
        throw new Error("init failed");
      },
      { getEpoch: () => 1 }
    );

    await expect(get()).rejects.toThrow("init failed");
    await expect(get()).rejects.toThrow("init failed");
    expect(calls).toBe(2);
  });

  test("discards a value built ACROSS an epoch move instead of caching it", async () => {
    // The hazard `widgets/agents.ts` handled by hand in PR #2586 R1, now
    // inherited by every consumer: a recycle landing DURING resolve() yields a
    // value already wrapping the torn-down pool. Checking the epoch only on
    // entry would cache it.
    let epoch = 1;
    const built: number[] = [];
    const get = createEpochKeyedCache(
      async () => {
        const id = built.length + 1;
        built.push(id);
        // The first build races a recycle; later builds are clean.
        if (id === 1) epoch = 2;
        return { id };
      },
      { getEpoch: () => epoch }
    );

    const value = await get();

    // Build #1 straddled the bump and must be discarded, not returned.
    expect(built).toEqual([1, 2]);
    expect(value.id).toBe(2);

    // And the retained value is the clean one.
    expect((await get()).id).toBe(2);
  });

  test("independent caches keep independent values under a shared epoch", async () => {
    let epoch = 1;
    const getA = createEpochKeyedCache(async () => "A1", { getEpoch: () => epoch });
    const getB = createEpochKeyedCache(async () => "B1", { getEpoch: () => epoch });

    expect(await getA()).toBe("A1");
    expect(await getB()).toBe("B1");

    epoch = 2;
    expect(await getA()).toBe("A1");
    expect(await getB()).toBe("B1");
  });
});
