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
      "not a missing configuration",
      "minsky persistence check",
    ]) {
      expect(fromProvider).toContain(shared);
      expect(fromThrow).toContain(shared);
    }
  });

  // ---- mt#4383: the two clauses mt#4379 retired on the sibling renderer ----

  test("neither renderer claims a CURRENT outage or a parity that does not hold", () => {
    // mt#4379 corrected a third renderer of this same state (the task-backend
    // message) and its regression test forbids exactly these two strings —
    // but only there. These two kept them, which is the whole of mt#4383:
    // `describePersistenceUnavailability` is the CANONICAL renderer that
    // `scripts/check-sql-capability-messages.ts` routes call sites into, so it
    // reached more surfaces than the one that got fixed.
    //
    // Why each is wrong, independent of tense:
    //  - "reports the same failure" asserts a parity nothing derives. It is
    //    backwards: `persistence check` probes the LIVE connection, so once the
    //    outage clears the two are EXPECTED to disagree. Two agent sessions
    //    spent their first diagnostic minutes on an already-healthy database
    //    following it.
    //  - "restart once the database is reachable" stopped being the remedy when
    //    mt#4379 made the container re-register dependents on recovery.
    for (const rendered of [
      describePersistenceUnavailability(new UnconfiguredPersistenceProvider(ENOTFOUND, true)),
      describeFailedPersistenceInit(new Error(ENOTFOUND)),
    ]) {
      expect(rendered).not.toContain("reports the same failure");
      expect(rendered).not.toContain("restart once the database is reachable");
    }

    // Positive half: they must still say something actionable about the
    // relationship, not merely drop the mention.
    for (const rendered of [
      describePersistenceUnavailability(new UnconfiguredPersistenceProvider(ENOTFOUND, true)),
      describeFailedPersistenceInit(new Error(ENOTFOUND)),
    ]) {
      expect(rendered).toContain("may well PASS while this fails");
    }
  });

  test("the throw path keeps its present tense, and the provider path does not", () => {
    // The asymmetry is deliberate and is the one judgment call in mt#4383.
    // `getSharedPersistenceService` PROPAGATES a failed init, so the cockpit's
    // error is a live throw from the attempt just made and "failed to
    // initialize" is accurate NOW. The provider path replays a record stored at
    // boot, which is the thing that made a present-tense claim a lie there.
    expect(describeFailedPersistenceInit(new Error(ENOTFOUND))).toContain(
      "the initialization attempt that just failed"
    );
    expect(
      describePersistenceUnavailability(new UnconfiguredPersistenceProvider(ENOTFOUND, true))
    ).toContain("AT BOOT");
  });
});
