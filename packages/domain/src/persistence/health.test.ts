/**
 * Tests for assessPersistenceHealth (mt#2949).
 *
 * These are the hermetic unit-level instances of the task's acceptance
 * tests:
 *   1. A simulated persistence-init throw in a deployed-context config
 *      (connection string configured, initialize() failed) must assess as
 *      unhealthy.
 *   2. Local/dev with no configured DB (no connection string anywhere) must
 *      still assess as healthy/degraded, and be distinguishable from case 1.
 *
 * No mocks — FakePersistenceProvider and UnconfiguredPersistenceProvider are
 * both real implementations of PersistenceProvider (DI-friendly, per
 * eslint-rules/no-global-module-mocks.js).
 */

import { describe, test, expect } from "bun:test";
import { assessPersistenceHealth } from "./health";
import { FakePersistenceProvider } from "./fake-persistence-provider";
import { UnconfiguredPersistenceProvider } from "./unconfigured-provider";

describe("assessPersistenceHealth", () => {
  test("a real SQL-capable provider assesses as healthy/connected", () => {
    const provider = new FakePersistenceProvider({ sql: true });
    const result = assessPersistenceHealth(provider);
    expect(result.healthy).toBe(true);
    expect(result.mode).toBe("connected");
  });

  test("no provider wired at all assesses as healthy/unconfigured (defensive default)", () => {
    const result = assessPersistenceHealth(undefined);
    expect(result.healthy).toBe(true);
    expect(result.mode).toBe("unconfigured");
  });

  test("deliberately unconfigured (no connection string anywhere) assesses as healthy/unconfigured — local/dev degraded mode is NOT an error (SC#2/#3)", () => {
    const provider = new UnconfiguredPersistenceProvider(
      "no Postgres connection configured",
      false
    );
    const result = assessPersistenceHealth(provider);
    expect(result.healthy).toBe(true);
    expect(result.mode).toBe("unconfigured");
    expect(result.reason).toMatch(/local\/dev/);
  });

  test("configured but failed to initialize (simulated boot-time throw, deployed context) assesses as unhealthy (SC#1)", () => {
    const provider = new UnconfiguredPersistenceProvider(
      "connect ECONNREFUSED — Postgres unreachable",
      true
    );
    const result = assessPersistenceHealth(provider);
    expect(result.healthy).toBe(false);
    expect(result.mode).toBe("unavailable");
    expect(result.reason).toContain("connect ECONNREFUSED");
  });

  test("the two UnconfiguredPersistenceProvider cases are distinguishable (SC#3)", () => {
    const unconfigured = assessPersistenceHealth(
      new UnconfiguredPersistenceProvider("no Postgres connection configured", false)
    );
    const unavailable = assessPersistenceHealth(
      new UnconfiguredPersistenceProvider("migration failed: CREATE SCHEMA drizzle", true)
    );
    expect(unconfigured.healthy).not.toBe(unavailable.healthy);
    expect(unconfigured.mode).not.toBe(unavailable.mode);
  });

  test("an sql=false provider that is NOT the known UnconfiguredPersistenceProvider placeholder is not silently green-lit (hardening, PR #2095 R1)", () => {
    // Postgres has been the only backend since mt#2349 — a non-Postgres,
    // non-Unconfigured provider is an unrecognized state in production. It
    // must not fall through to the deliberately-unconfigured (healthy) case.
    const provider = new FakePersistenceProvider({ sql: false });
    const result = assessPersistenceHealth(provider);
    expect(result.healthy).toBe(false);
    expect(result.mode).toBe("unavailable");
    expect(result.reason).toContain("Unrecognized non-SQL persistence provider");
  });

  // mt#3635 / ADR-035 rule 4: `mode` and `reason` alone cannot tell an operator
  // whether the process is STUCK in its boot-time failure or actively retrying
  // against a real outage — the two produced byte-identical payloads before.
  describe("retry reporting (mt#3635)", () => {
    /** The originating incident's boot-time failure (2026-08-03). */
    const ENOTFOUND = "getaddrinfo ENOTFOUND";

    test("a provider that has never retried since boot reports no lastAttemptAt", () => {
      const provider = new UnconfiguredPersistenceProvider(ENOTFOUND, true);
      const result = assessPersistenceHealth(provider);
      expect(result.lastAttemptAt).toBeUndefined();
      expect(result.reason).toContain("No re-initialization has been attempted since boot");
    });

    test("a provider that retried and still failed reports the attempt timestamp", () => {
      const provider = new UnconfiguredPersistenceProvider(ENOTFOUND, true);
      const at = new Date("2026-08-04T07:00:00.000Z");
      provider.noteRetryAttempt(at, ENOTFOUND);

      const result = assessPersistenceHealth(provider);
      expect(result.lastAttemptAt).toBe("2026-08-04T07:00:00.000Z");
      expect(result.reason).toContain("Last re-initialization attempt 2026-08-04T07:00:00.000Z");
      expect(result.reason).not.toContain("No re-initialization has been attempted");
    });

    test("the stuck and still-retrying states are distinguishable", () => {
      const stuck = new UnconfiguredPersistenceProvider(ENOTFOUND, true);
      const retrying = new UnconfiguredPersistenceProvider(ENOTFOUND, true);
      retrying.noteRetryAttempt(new Date("2026-08-04T07:00:00.000Z"), "still failing");

      expect(assessPersistenceHealth(stuck).reason).not.toBe(
        assessPersistenceHealth(retrying).reason
      );
    });
  });
});
