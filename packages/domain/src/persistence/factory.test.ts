/**
 * Tests for PersistenceProviderFactory error messages.
 *
 * mt#1280: the factory's error messages were generic before and made the
 * 4.5-hour hosted-MCP outage hard to diagnose. These tests lock in the
 * specific failure-mode messages — they must name the missing config path
 * AND the env var that should populate it, so the next misconfig is not a
 * 4-hour mystery.
 */

import { describe, test, expect } from "bun:test";
import {
  PersistenceProviderFactory,
  resolvePersistenceProvider,
  resolvePersistenceProviderOrError,
} from "./factory";
import type { PersistenceConfig } from "./types";

describe("PersistenceProviderFactory error messages (mt#1280)", () => {
  test("postgres backend without postgres block names both env vars", async () => {
    const config: PersistenceConfig = {
      backend: "postgres",
    } as PersistenceConfig;

    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /persistence\.backend='postgres' but persistence\.postgres is undefined/
    );
    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /MINSKY_PERSISTENCE_POSTGRES_URL/
    );
    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(/MINSKY_POSTGRES_URL/);
  });

  test("postgres backend with empty connectionString names both env vars", async () => {
    const config: PersistenceConfig = {
      backend: "postgres",
      postgres: { connectionString: "" },
    } as PersistenceConfig;

    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /persistence\.postgres\.connectionString is empty or whitespace/
    );
    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /MINSKY_PERSISTENCE_POSTGRES_URL/
    );
    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(/MINSKY_POSTGRES_URL/);
  });

  test("postgres backend with whitespace-only connectionString fails the same way", async () => {
    const config: PersistenceConfig = {
      backend: "postgres",
      postgres: { connectionString: "   \t\n  " },
    } as PersistenceConfig;

    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /persistence\.postgres\.connectionString is empty or whitespace/
    );
  });
});

/**
 * mt#3750: the same discipline as the mt#1280 tests above, one layer out. Those
 * lock in that a CONFIG failure names what to fix; these lock in that a
 * RESOLUTION failure reaches the caller as a cause at all, rather than as a bare
 * `null` every caller has to invent an explanation for.
 *
 * No mocks and no database: the test process never calls
 * `initializeConfiguration` (`tests/setup.ts` loads only the reflect polyfill),
 * so resolution fails here for a reason that does not depend on whether a
 * database is reachable.
 */
describe("resolvePersistenceProviderOrError (mt#3750)", () => {
  test("a failed resolution carries the cause instead of discarding it", async () => {
    const resolution = await resolvePersistenceProviderOrError();

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;

    expect(resolution.error).toContain("Configuration not initialized");
    expect(resolution.errorClass).toBe("Error");
  });

  test("resolvePersistenceProvider still returns null over the same failure", async () => {
    // The contract 44+ existing call sites branch on is unchanged by the
    // additive sibling above — this is the regression guard for that promise.
    expect(await resolvePersistenceProvider()).toBeNull();
  });

  test("the two functions agree on whether a provider was produced", async () => {
    const resolution = await resolvePersistenceProviderOrError();
    const provider = await resolvePersistenceProvider();

    // Env-independent coupling: null exactly when the resolution is not ok.
    expect(provider === null).toBe(!resolution.ok);
  });
});
