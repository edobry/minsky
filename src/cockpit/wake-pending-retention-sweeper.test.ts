/**
 * mt#4537 / PR #3311 R1 — the retention tick's availability decision.
 *
 * The reviewer found a guard that looked right and could never fire: it asked whether
 * the provider HAS `getDatabaseConnection`, and `UnconfiguredPersistenceProvider`
 * defines one (it throws). So the unconfigured path fell through to the generic catch
 * and lost the structured reason the code was written to report.
 *
 * These tests use the REAL `UnconfiguredPersistenceProvider` rather than a hand-made
 * fake for that exact reason: a fake would have whatever shape the test author believed
 * it had, which is the belief that produced the defect.
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  PersistenceUnavailableError,
  UnconfiguredPersistenceProvider,
} from "@minsky/domain/persistence/unconfigured-provider";
import type {
  PersistenceCapabilities,
  PersistenceProvider,
} from "@minsky/domain/persistence/types";
import type { WakePendingRetentionResult } from "@minsky/domain/ask/wake-pending-retention";

import { runWakePendingRetentionTick } from "./wake-pending-retention-sweeper";

const SQL_CAPABLE: PersistenceCapabilities = {
  sql: true,
  transactions: true,
  jsonb: true,
  vectorStorage: false,
  migrations: true,
};

const NOTHING_DELETED: WakePendingRetentionResult = {
  deletedDelivered: 0,
  deletedUndeliverable: 0,
};

/**
 * A provider that CLAIMS SQL and refuses anyway — the configured-but-unreachable case.
 * Deliberately not an `UnconfiguredPersistenceProvider`: that one is caught by the
 * capability check, and this exercises the other branch.
 */
function claimsSqlButThrows(): PersistenceProvider {
  return {
    capabilities: SQL_CAPABLE,
    getCapabilities: () => SQL_CAPABLE,
    initialize: async () => {},
    close: async () => {},
    getConnectionInfo: () => "test double",
    getDatabaseConnection: async () => {
      throw new PersistenceUnavailableError("connection refused");
    },
  } as unknown as PersistenceProvider;
}

function claimsSql(db: unknown): PersistenceProvider {
  return {
    capabilities: SQL_CAPABLE,
    getCapabilities: () => SQL_CAPABLE,
    initialize: async () => {},
    close: async () => {},
    getConnectionInfo: () => "test double",
    getDatabaseConnection: async () => db,
  } as unknown as PersistenceProvider;
}

/**
 * The real provider, plus a counter for the one thing the fix changed.
 *
 * A subclass rather than a fake: `getDatabaseConnection` is defined exactly as the
 * parent defines it (count, then delegate), so the method-presence property that
 * defeated the old guard is preserved intact — which is the property under test.
 *
 * The counter exists because the outcome alone cannot discriminate. Restoring the old
 * `in`-based guard leaves every result assertion passing: the call throws
 * `PersistenceUnavailableError`, the catch block converts it, and the tick still returns
 * `{ ok: false }` having never swept. Both fixes land on the same outcome by design, so
 * an outcome-only test is inert against the defect (mt#4512's shape — a control that
 * does not fire may mean the assertion is measuring the wrong thing). Whether the tick
 * CALLS a provider it has no business calling is the difference, and it is observable.
 */
class CountingUnconfiguredProvider extends UnconfiguredPersistenceProvider {
  connectionAttempts = 0;

  override async getDatabaseConnection(): Promise<unknown> {
    this.connectionAttempts++;
    return super.getDatabaseConnection();
  }
}

describe("runWakePendingRetentionTick", () => {
  test("never reaches for a connection on an unconfigured provider", async () => {
    const provider = new CountingUnconfiguredProvider("no connection string");
    let swept = false;
    const result = await runWakePendingRetentionTick({
      getProvider: async () => provider,
      sweep: async () => {
        swept = true;
        return NOTHING_DELETED;
      },
    });

    expect(result).toEqual({ ok: false });
    expect(swept).toBe(false);
    // The load-bearing assertion. The old method-presence guard let this provider
    // through and only stopped at the throw inside the call.
    expect(provider.connectionAttempts).toBe(0);
  });

  test("same for a configured-but-failed provider", async () => {
    const result = await runWakePendingRetentionTick({
      getProvider: async () =>
        new UnconfiguredPersistenceProvider(
          "migration failed",
          /* configuredButUnavailable */ true
        ),
      sweep: async () => NOTHING_DELETED,
    });

    expect(result).toEqual({ ok: false });
  });

  test("a provider that claims SQL and then refuses is still a domain failure, not a throw", async () => {
    const result = await runWakePendingRetentionTick({
      getProvider: async () => claimsSqlButThrows(),
      sweep: async () => NOTHING_DELETED,
    });

    expect(result).toEqual({ ok: false });
  });

  test("a null connection is a domain failure", async () => {
    let swept = false;
    const result = await runWakePendingRetentionTick({
      getProvider: async () => claimsSql(null),
      sweep: async () => {
        swept = true;
        return NOTHING_DELETED;
      },
    });

    expect(result).toEqual({ ok: false });
    expect(swept).toBe(false);
  });

  test("sweeps and reports success on a SQL-capable provider", async () => {
    const db = {} as PostgresJsDatabase;
    let received: unknown;
    const result = await runWakePendingRetentionTick({
      getProvider: async () => claimsSql(db),
      sweep: async (passed) => {
        received = passed;
        return { deletedDelivered: 1, deletedUndeliverable: 2 };
      },
    });

    expect(result).toEqual({ ok: true });
    expect(received).toBe(db);
  });

  test("an unexpected error is a domain failure rather than an escape", async () => {
    const result = await runWakePendingRetentionTick({
      getProvider: async () => claimsSql({} as PostgresJsDatabase),
      sweep: async () => {
        throw new Error('relation "wake_pending" does not exist');
      },
    });

    expect(result).toEqual({ ok: false });
  });
});
