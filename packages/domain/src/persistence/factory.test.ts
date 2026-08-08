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
  toResolutionFailure,
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
 * These assert only what the code owns. An earlier draft asserted that
 * `resolvePersistenceProviderOrError()` TAKES the failure branch — true when the
 * file runs alone (nothing initializes configuration), false in the full gated
 * suite, where a sibling test file initializes it in the shared process and a
 * live database is reachable. It passed the single-file run and failed
 * pre-push. Which branch that function takes is ambient state the test does not
 * own; the failure SHAPING is what this change introduces, so that is what is
 * pinned here.
 */
describe("toResolutionFailure (mt#3750)", () => {
  test("scrubs credentials out of the message the caller will publish", async () => {
    // The failure string is written into guard-health, which is persisted and
    // rendered into an operator-facing banner — a driver error can embed the DSN.
    const failure = await toResolutionFailure(
      new Error("connect failed: postgres://minsky:hunter2@db.example.com:6543/postgres")
    );

    expect(failure.error).not.toContain("hunter2");
    expect(failure.ok).toBe(false);
  });

  test("names the error class, which survives scrubbing unconditionally", async () => {
    expect((await toResolutionFailure(new TypeError("bad property access"))).errorClass).toBe(
      "TypeError"
    );
    expect((await toResolutionFailure(new Error("write CONNECT_TIMEOUT"))).errorClass).toBe(
      "Error"
    );
  });

  test("handles a non-Error throw without losing the value", async () => {
    const failure = await toResolutionFailure("thrown as a bare string");

    expect(failure.errorClass).toBe("string");
    expect(failure.error).toContain("thrown as a bare string");
  });
});

describe("resolvePersistenceProviderOrError (mt#3750)", () => {
  test("the two functions agree on whether a provider was produced", async () => {
    const resolution = await resolvePersistenceProviderOrError();
    const provider = await resolvePersistenceProvider();

    // Env-independent: `resolvePersistenceProvider` returns null exactly when
    // the resolution is not ok. This is the regression guard for the promise
    // that the additive sibling left the `| null` contract — which 44+ call
    // sites branch on — unchanged.
    expect(provider === null).toBe(!resolution.ok);
  });

  test("whichever branch it takes carries that branch's own invariant", async () => {
    const resolution = await resolvePersistenceProviderOrError();

    if (resolution.ok) {
      expect(resolution.provider).toBeTruthy();
    } else {
      expect(resolution.errorClass.length).toBeGreaterThan(0);
    }
  });
});
