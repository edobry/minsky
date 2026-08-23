/**
 * Tests for the MCP daemon's DB-reachability binding (mt#4466).
 *
 * The tracker's own state machine is covered by
 * `packages/domain/src/persistence/reachability.test.ts`. What is asserted here
 * is the BINDING: that the probe issues the right query through the right
 * connection, that every "cannot reach" shape rejects rather than resolving
 * (a probe that resolves on a missing provider would report a wedged pool as
 * healthy — the exact failure class this task exists to close), and that a
 * process with no tracker installed emits no claim at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetDbReachabilityForTests,
  installDbReachabilityTracker,
  probeViaProvider,
  readDbReachability,
} from "./db-reachability";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";

afterEach(() => {
  __resetDbReachabilityForTests();
});

/** A provider whose raw connection records the query it was handed. */
function providerWithRawSql(
  onUnsafe: (query: string, parameters?: unknown[]) => Promise<unknown>,
  sqlCapable = true
): PersistenceProvider {
  return {
    getCapabilities: () => ({
      sql: sqlCapable,
      transactions: true,
      jsonb: true,
      vectorStorage: false,
      migrations: true,
    }),
    getRawSqlConnection: async () => ({ unsafe: onUnsafe }),
  } as unknown as PersistenceProvider;
}

describe("probeViaProvider", () => {
  test("issues a PARAMETERIZED query through .unsafe()", async () => {
    // Both properties are load-bearing and easy to "simplify" into a defect: a
    // zero-bind query is the shape that wedges a transaction-mode pooler under
    // concurrency, and a tagged template would bypass the pooler guard's
    // in-flight cap. A probe for pool health must not be able to cause the
    // condition it reports.
    const calls: Array<{ query: string; parameters?: unknown[] }> = [];
    const provider = providerWithRawSql(async (query, parameters) => {
      calls.push({ query, parameters });
      return [{ reachable: 1 }];
    });

    await probeViaProvider(() => provider);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("$1");
    expect(calls[0]?.parameters).toEqual([1]);
  });

  test("rejects when no provider is wired", async () => {
    // Resolving here would report a daemon with no database as reachable.
    await expect(probeViaProvider(() => undefined)).rejects.toThrow(
      "no persistence provider is wired"
    );
  });

  test("rejects when the provider exposes no raw SQL access", async () => {
    const provider = {
      getCapabilities: () => ({ sql: false }),
    } as unknown as PersistenceProvider;

    await expect(probeViaProvider(() => provider)).rejects.toThrow("no raw SQL connection");
  });

  test("rejects when the raw connection resolves to null", async () => {
    const provider = {
      getCapabilities: () => ({ sql: true }),
      getRawSqlConnection: async () => null,
    } as unknown as PersistenceProvider;

    await expect(probeViaProvider(() => provider)).rejects.toThrow(
      "returned no raw SQL connection"
    );
  });

  test("propagates a rejection from the query itself", async () => {
    const provider = providerWithRawSql(async () => {
      throw new Error("ECHECKOUTTIMEOUT: unable to check out connection from the pool");
    });

    await expect(probeViaProvider(() => provider)).rejects.toThrow("ECHECKOUTTIMEOUT");
  });
});

describe("readDbReachability", () => {
  test("returns undefined when no tracker is installed", () => {
    // A stdio process serves no /health. Emitting a status here would make
    // `buildMcpHealthResponse` publish a claim nothing measured.
    expect(readDbReachability()).toBeUndefined();
  });

  test("reports ok once a probe gets through", async () => {
    const provider = providerWithRawSql(async () => [{ reachable: 1 }]);
    const tracker = installDbReachabilityTracker(() => provider);

    await tracker.refresh();

    expect(readDbReachability()?.status).toBe("ok");
    expect(readDbReachability()?.check.checkedAt).not.toBeNull();
  });

  test("reports degraded — not unreachable — when a wired pool stops answering", async () => {
    // The mem#1120 R2 shape: `sql` capability is true (so
    // `assessPersistenceHealth` still says `connected`) while no query
    // completes. Degraded and unreachable have opposite remedies, so the split
    // has to survive the binding, not just the tracker.
    const provider = providerWithRawSql(async () => {
      throw new Error("ECHECKOUTTIMEOUT");
    }, true);
    const tracker = installDbReachabilityTracker(() => provider);

    await tracker.refresh();

    expect(readDbReachability()?.status).toBe("degraded");
  });

  test("reports unreachable when nothing is wired at all", async () => {
    const tracker = installDbReachabilityTracker(() => undefined);

    await tracker.refresh();

    expect(readDbReachability()?.status).toBe("unreachable");
  });

  test("install is idempotent per process", () => {
    const provider = providerWithRawSql(async () => []);
    const first = installDbReachabilityTracker(() => provider);
    const second = installDbReachabilityTracker(() => provider);

    expect(second).toBe(first);
  });

  test("reading kicks a probe without awaiting it", async () => {
    // The non-await is what keeps /health fast while the pool it reports on is
    // wedged. A read must return synchronously even when the probe never
    // settles.
    let issued = 0;
    const provider = providerWithRawSql(() => {
      issued++;
      return new Promise<never>(() => {
        /* never settles */
      });
    });
    installDbReachabilityTracker(() => provider);

    const snapshot = readDbReachability();

    // Returned immediately, with the pre-probe status rather than blocking.
    expect(snapshot).toBeDefined();
    expect(snapshot?.status).toBe("unreachable");
    // The probe was kicked; it is in flight, not awaited.
    await Promise.resolve();
    expect(issued).toBe(1);
  });
});
