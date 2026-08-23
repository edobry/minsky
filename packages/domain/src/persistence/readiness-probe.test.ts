/**
 * mt#4471 — persistence readiness probe.
 *
 * The behaviour under test is the one the 2026-08-23 outage needed and did not
 * have: a saturated pool must produce a NOT-ready verdict rather than an
 * indefinite wait. `postgres` (postgres.js) has no checkout timeout, so a query
 * against an exhausted pool never settles — the "never settles" fixture below
 * is that condition, not an artificial one.
 *
 * No real timers and no database: `delay` and `now` are injected, so these run
 * in microseconds and cannot flake.
 */

import { describe, expect, test } from "bun:test";
import { assessProbeOutcome, createReadinessProbe } from "./readiness-probe";

const CHECKED_AT = "2026-08-23T18:00:00.000Z";

describe("assessProbeOutcome (functional core)", () => {
  test("a completed round trip is ready, with no reason to explain", () => {
    const result = assessProbeOutcome({
      outcome: { kind: "ok" },
      timeoutMs: 1500,
      durationMs: 3,
      checkedAt: CHECKED_AT,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.durationMs).toBe(3);
    expect(result.checkedAt).toBe(CHECKED_AT);
  });

  test("a timeout is not ready, and names the bound plus the pool", () => {
    const result = assessProbeOutcome({
      outcome: { kind: "timeout" },
      timeoutMs: 1500,
      durationMs: 1500,
      checkedAt: CHECKED_AT,
    });

    expect(result.ok).toBe(false);
    // The operator-facing half: the reason has to distinguish "the pool is not
    // serving" from "the database is down", because the remedies differ.
    expect(result.reason).toContain("1500ms");
    expect(result.reason).toContain("connection pool");
  });

  test("a thrown error is not ready, and carries the driver's message", () => {
    const result = assessProbeOutcome({
      outcome: { kind: "error", message: "connect ECONNREFUSED 127.0.0.1:5432" },
      timeoutMs: 1500,
      durationMs: 12,
      checkedAt: CHECKED_AT,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ECONNREFUSED");
  });
});

describe("createReadinessProbe (shell)", () => {
  test("reports ready when the query completes", async () => {
    const probe = createReadinessProbe({
      runProbeQuery: async () => {},
      timeoutMs: 1500,
      now: () => 1_000,
      delay: () => new Promise<void>(() => {}), // timer never fires
    });

    const result = await probe.check();
    expect(result.ok).toBe(true);
  });

  test("SATURATION: a query that never settles reports not-ready rather than hanging", async () => {
    // This is the outage. postgres.js queues without bound when every pooled
    // connection is busy, so the query promise simply never settles. Before
    // mt#4471 nothing raced it and `/health` answered `ready: true` throughout.
    const probe = createReadinessProbe({
      runProbeQuery: () => new Promise<void>(() => {}),
      timeoutMs: 1500,
      now: () => 1_000,
      delay: async () => {},
    });

    const result = await probe.check();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("connection pool");
  });

  test("a throwing query is reported, not propagated — the probe never rejects", async () => {
    const probe = createReadinessProbe({
      runProbeQuery: async () => {
        throw new Error("relation does not exist");
      },
      timeoutMs: 1500,
      now: () => 1_000,
      delay: () => new Promise<void>(() => {}),
    });

    const result = await probe.check();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("relation does not exist");
  });

  test("concurrent callers share ONE query — the probe cannot pressure the pool it measures", async () => {
    let queries = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const probe = createReadinessProbe({
      runProbeQuery: async () => {
        queries += 1;
        await gate;
      },
      timeoutMs: 1500,
      now: () => 1_000,
      delay: () => new Promise<void>(() => {}),
    });

    const all = Promise.all([probe.check(), probe.check(), probe.check()]);
    release();
    const results = await all;

    expect(queries).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("PR #3265 R1: a timed-out check does NOT leak a second query on the next poll", async () => {
    // The reviewer's BLOCKING finding. A timed-out check RESOLVES while its
    // query stays parked in postgres.js's unbounded queue — there is no
    // checkout timeout to cancel it. Keyed on the check alone, every
    // subsequent poll would issue another query that also never leaves, so on
    // a saturated pool /health would accumulate one parked query per poll and
    // become a source of the pressure it reports.
    let queries = 0;
    let clock = 1_000;

    const probe = createReadinessProbe({
      runProbeQuery: () => {
        queries += 1;
        return new Promise<void>(() => {}); // never settles: the saturated pool
      },
      timeoutMs: 1500,
      now: () => clock,
      delay: async () => {},
    });

    const first = await probe.check();
    expect(first.ok).toBe(false);
    expect(queries).toBe(1);

    // The tray polls again 5s later.
    clock += 5_000;
    const second = await probe.check();

    expect(second.ok).toBe(false);
    expect(queries).toBe(1); // <-- the fix: still ONE, not two
    expect(second.reason).toContain("has not settled");
    expect(second.reason).toContain("5000ms");

    // ...and again, for as long as it stays parked.
    clock += 5_000;
    await probe.check();
    expect(queries).toBe(1);
  });

  test("once the parked query finally settles, the next check probes again", async () => {
    // The other half: declining to re-probe must not latch not-ready forever
    // after the pool recovers.
    let queries = 0;
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let clock = 1_000;
    // The first check must time out; the recovery check must not. An
    // instant-resolving timer would win the race even against an
    // already-resolved query (the query settles through a longer promise
    // chain), so the timer is armed per-phase rather than globally.
    let timerFires = true;

    const probe = createReadinessProbe({
      runProbeQuery: () => {
        queries += 1;
        return queries === 1 ? parked : Promise.resolve();
      },
      timeoutMs: 1500,
      now: () => clock,
      delay: () => (timerFires ? Promise.resolve() : new Promise<void>(() => {})),
    });

    await probe.check();
    expect(queries).toBe(1);
    timerFires = false;

    release();
    await parked;
    // The slot is released by a `.finally()` several links down the
    // implementation's promise chain, so awaiting `parked` alone is not enough
    // to observe it. A macrotask boundary flushes the whole microtask queue.
    // (In production the gap is microseconds against a 5s poll — this is a test
    // ordering concern, not a race the daemon can hit.)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    clock += 5_000;
    const afterRecovery = await probe.check();

    expect(queries).toBe(2);
    expect(afterRecovery.ok).toBe(true);
  });

  test("a settled probe does not latch — the next check runs a fresh query", async () => {
    // ADR-035's rule against memoizing a failed initializer, applied to a probe:
    // a transient failure must not pin `ready: false` for the process lifetime.
    let attempt = 0;
    const probe = createReadinessProbe({
      runProbeQuery: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient");
      },
      timeoutMs: 1500,
      now: () => 1_000,
      delay: () => new Promise<void>(() => {}),
    });

    const first = await probe.check();
    const second = await probe.check();

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(attempt).toBe(2);
  });
});
