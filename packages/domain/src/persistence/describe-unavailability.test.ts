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
  PersistenceUnavailableError,
  describePersistenceUnavailability,
} from "./unconfigured-provider";
import { FakePersistenceProvider } from "./fake-persistence-provider";

/** The verbatim boot failure from the 2026-08-03 incident. */
const BOOT_FAILURE = "getaddrinfo ENOTFOUND";

describe("describePersistenceUnavailability (mt#3636)", () => {
  test("configured-but-unavailable names the boot failure as a BOOT fact", () => {
    const described = describePersistenceUnavailability(
      new UnconfiguredPersistenceProvider(BOOT_FAILURE, true)
    );

    expect(described).toContain("Postgres IS configured");
    expect(described).toContain(BOOT_FAILURE);
    expect(described).toContain("AT BOOT");
    // Must not send the operator off to fix a config that is already correct.
    expect(described).not.toContain("Set persistence.postgres.connectionString");
  });

  // ---- mt#4383: a boot observation must not be rendered as current state ----
  //
  // This test previously asserted the message "says the DB is unreachable".
  // That assertion was the defect, pinned: the claim describes the moment
  // initialization failed and goes false the instant the database recovers.
  // mt#4379 corrected the sibling task-backend renderer and its regression test
  // forbids these strings there; this is the same guard for the CANONICAL
  // renderer, which `scripts/check-sql-capability-messages.ts` routes call
  // sites into and which therefore reaches more surfaces than the one fixed.
  test("does not claim a CURRENT outage, nor a parity with persistence check", () => {
    const described = describePersistenceUnavailability(
      new UnconfiguredPersistenceProvider(BOOT_FAILURE, true)
    );

    expect(described).not.toContain("The database is unreachable");
    expect(described).not.toContain("reports the same failure");
    // Retired by mt#4379: the container now re-registers dependents on
    // recovery, so a restart is no longer the remedy this sentence promised.
    expect(described).not.toContain("restart once the database is reachable");
    // The relationship is stated rather than dropped — `persistence check`
    // probes the live connection, so the two are EXPECTED to disagree.
    expect(described).toContain("may well PASS while this fails");
  });

  test("with no retry recorded, it says so rather than implying a live outage", () => {
    // ADR-035 rule 4 makes the ABSENT case load-bearing: it is what separates
    // "stuck since boot" from "still retrying against a real outage". A fresh
    // provider has never been re-initialized.
    const described = describePersistenceUnavailability(
      new UnconfiguredPersistenceProvider(BOOT_FAILURE, true)
    );

    expect(described).toContain("has NOT been re-initialized since boot");
    expect(described).toContain("may well have recovered");
  });

  test("with a retry recorded, it reports when and why that retry failed", () => {
    const provider = new UnconfiguredPersistenceProvider(BOOT_FAILURE, true);
    const at = new Date("2026-08-21T20:00:00.000Z");
    provider.noteRetryAttempt(at, "ECONNREFUSED");

    const described = describePersistenceUnavailability(provider);

    expect(described).toContain(at.toISOString());
    expect(described).toContain("ECONNREFUSED");
    // The never-retried wording must not survive alongside a recorded attempt.
    expect(described).not.toContain("has NOT been re-initialized since boot");
  });

  test("deliberately unconfigured points at the config, not at a boot failure", () => {
    const described = describePersistenceUnavailability(
      new UnconfiguredPersistenceProvider("no Postgres connection configured", false)
    );

    expect(described).toContain("Persistence is not configured");
    expect(described).toContain("persistence.postgres.connectionString");
    // Case-insensitive: the configured-but-failed branch renders "AT BOOT" in
    // caps since mt#4383, and a case-sensitive assertion here would pass for
    // the wrong reason if the branches were ever confused.
    expect(described.toLowerCase()).not.toContain("failed to initialize at boot");
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

/**
 * Regression guard for the surfaces mt#3636 did NOT have to fix (mt#3636 SC5).
 *
 * `session_*` and `memory_*` already failed loudly during the incident, and the
 * reason they did is entirely this class: every DB accessor throws, the
 * capability flags read false, and the thrown error is `bootDeferrable` so the
 * DI container converts it into its own "Service X is unavailable" message
 * rather than crashing the process at boot.
 *
 * That is the shared root beneath both surfaces, so it is the thing worth
 * pinning: if any accessor here started returning a value instead of throwing,
 * `session_*` and `memory_*` would silently re-open exactly the hole this task
 * closed on the task read path. (Scope note: this asserts the mechanism, not
 * the two command surfaces end-to-end — those were verified live via the CLI,
 * recorded in the PR body's evidence block.)
 */
describe("UnconfiguredPersistenceProvider stays fail-closed (mt#3636 SC5)", () => {
  const degraded = () => new UnconfiguredPersistenceProvider(BOOT_FAILURE, true);

  test("getDatabaseConnection throws rather than returning null", async () => {
    await expect(degraded().getDatabaseConnection()).rejects.toBeInstanceOf(
      PersistenceUnavailableError
    );
  });

  test("getRawSqlConnection throws rather than returning null", async () => {
    await expect(degraded().getRawSqlConnection()).rejects.toBeInstanceOf(
      PersistenceUnavailableError
    );
  });

  test("getVectorStorageForDomain throws rather than returning an empty store", () => {
    expect(() => degraded().getVectorStorageForDomain("tasks", 1536)).toThrow(
      PersistenceUnavailableError
    );
  });

  test("every capability reads false — what memory_*'s SQL-capability guard keys on", () => {
    expect(degraded().getCapabilities()).toEqual({
      sql: false,
      transactions: false,
      jsonb: false,
      vectorStorage: false,
      migrations: false,
    });
  });

  test("the thrown error is bootDeferrable — what produces session_*'s container message", async () => {
    const error = await degraded()
      .getDatabaseConnection()
      .then(
        (): never => {
          throw new Error("expected getDatabaseConnection to reject, but it resolved");
        },
        (e: unknown) => e as PersistenceUnavailableError
      );

    expect(error.bootDeferrable).toBe(true);
    // The reason must survive into the message the operator actually reads.
    expect(error.message).toContain(BOOT_FAILURE);
  });
});
