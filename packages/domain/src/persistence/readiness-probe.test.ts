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
