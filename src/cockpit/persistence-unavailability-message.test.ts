/**
 * mt#3661 — the cockpit's failed-init cause renderer.
 *
 * This covers the branch that ACTUALLY runs when the cockpit is degraded. The
 * mt#3661 acceptance test (a live cockpit against an unresolvable Postgres host)
 * found the first implementation returning the generic "not SQL-capable"
 * sentence here, because `getSharedPersistenceService` PROPAGATES a failed init
 * rather than substituting an `UnconfiguredPersistenceProvider` the way
 * `createDomainContainer` does. There is no provider to interrogate on this
 * path — the boot error is the only cause available, and discarding it defeats
 * the point of the task.
 */
import { describe, test, expect } from "bun:test";
import { describeFailedPersistenceInit } from "./db-providers";
import { describePersistenceUnavailability } from "@minsky/domain/persistence/unconfigured-provider";
import { UnconfiguredPersistenceProvider } from "@minsky/domain/persistence/unconfigured-provider";

/** The originating incident's boot failure (mt#3635/mt#3636, 2026-08-03). */
const ENOTFOUND = "getaddrinfo ENOTFOUND";

describe("describeFailedPersistenceInit (mt#3661)", () => {
  test("names the underlying boot error", () => {
    const described = describeFailedPersistenceInit(new Error(ENOTFOUND));

    expect(described).toContain(ENOTFOUND);
    // The distinction ADR-035 rule 3 requires: configured-but-failing, NOT
    // missing configuration.
    expect(described).toContain("Postgres IS configured");
    expect(described).toContain("not a missing");
  });

  test("does not fall back to the bare cause-free sentence", () => {
    // The regression the live check caught: this branch previously returned the
    // generic sentence, which says nothing an operator can act on.
    const described = describeFailedPersistenceInit(new Error(ENOTFOUND));

    expect(described).not.toBe("The active persistence provider is not SQL-capable.");
  });

  test("handles a non-Error rejection without losing the reason", () => {
    // `getSharedPersistenceService` races a timeout; a rejection is not
    // guaranteed to be an Error subclass.
    expect(describeFailedPersistenceInit("init timed out after 5000ms")).toContain(
      "init timed out after 5000ms"
    );
  });

  test("agrees with the domain helper's configured-but-failed wording", () => {
    // Both describe the SAME state and differ only in how the bootstrap reported
    // it, so their guidance must not diverge — an operator should not get
    // different advice from the cockpit than from the MCP adapters.
    const fromProvider = describePersistenceUnavailability(
      new UnconfiguredPersistenceProvider(ENOTFOUND, true)
    );
    const fromThrow = describeFailedPersistenceInit(new Error(ENOTFOUND));

    for (const shared of [
      "Postgres IS configured",
      "The database is unreachable",
      "minsky persistence check",
    ]) {
      expect(fromProvider).toContain(shared);
      expect(fromThrow).toContain(shared);
    }
  });
});
