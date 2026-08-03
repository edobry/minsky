/**
 * `describePersistenceUnavailability` (mt#3636).
 *
 * The capability flags are all-false in BOTH the "never configured" and the
 * "configured and unreachable" cases, so a consumer that only dumps
 * capabilities cannot tell an operator which one they are in — and the two need
 * opposite responses (fix your config vs. the database is down). The
 * discriminating detail was already on the placeholder; this helper surfaces it
 * so `memory_*` and `asks_*` can name the cause the way `persistence_check`
 * already does.
 *
 * No mocks: `UnconfiguredPersistenceProvider` is the real class.
 */

import { describe, test, expect } from "bun:test";
import {
  UnconfiguredPersistenceProvider,
  describePersistenceUnavailability,
} from "./unconfigured-provider";
import { FakePersistenceProvider } from "./fake-persistence-provider";

describe("describePersistenceUnavailability (mt#3636)", () => {
  test("configured-but-unavailable names the boot failure and says the DB is unreachable", () => {
    const described = describePersistenceUnavailability(
      new UnconfiguredPersistenceProvider("getaddrinfo ENOTFOUND", true)
    );

    expect(described).toContain("Postgres IS configured");
    expect(described).toContain("getaddrinfo ENOTFOUND");
    expect(described).toContain("unreachable");
    // Must not send the operator off to fix a config that is already correct.
    expect(described).not.toContain("Set persistence.postgres.connectionString");
  });

  test("deliberately unconfigured points at the config, not at a boot failure", () => {
    const described = describePersistenceUnavailability(
      new UnconfiguredPersistenceProvider("no Postgres connection configured", false)
    );

    expect(described).toContain("Persistence is not configured");
    expect(described).toContain("persistence.postgres.connectionString");
    expect(described).not.toContain("failed to initialize at boot");
  });

  test("an unrelated provider gets the generic description rather than a fabricated cause", () => {
    const described = describePersistenceUnavailability(new FakePersistenceProvider());

    expect(described).toBe("The active persistence provider is not SQL-capable.");
  });

  test("a non-provider value does not throw", () => {
    expect(describePersistenceUnavailability(undefined)).toContain("not SQL-capable");
    expect(describePersistenceUnavailability(null)).toContain("not SQL-capable");
  });
});
