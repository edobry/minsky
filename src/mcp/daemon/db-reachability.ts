/**
 * The MCP daemon's live DB-reachability probe (mt#4466).
 *
 * Binds the domain-layer {@link DbReachabilityTracker} to whatever persistence
 * provider the DI container resolved, and exposes the three calls `/health`
 * needs: kick a probe, read the status, read the detail.
 *
 * ## Why the query looks like this
 *
 * Two properties, both inherited from the cockpit's mt#2773/mt#3563 work rather
 * than chosen fresh here, and both easy to "simplify" into a defect:
 *
 * 1. **It is PARAMETERIZED.** `select $1::int` carries a bind on purpose.
 *    Zero-bind queries are the shape that wedges a transaction-mode pooler under
 *    concurrency — with a bind, postgres-js sends Parse+Describe+Flush first and
 *    self-paces. A probe for pool health must not be able to cause the condition
 *    it reports. Do not shorten it to `select 1`.
 * 2. **It goes through `.unsafe()`, not a tagged template.** That subjects it to
 *    the pooler guard's in-flight cap like every other raw query, instead of
 *    reaching the unguarded underlying instance.
 *
 * And the reason it uses the SHARED pool at all: a probe on a dedicated
 * side-connection would have reported healthy right through mem#1120 R2. The
 * database was fine — the CLI, which opens its own connection, served the
 * identical read in 1.19s while MCP hung past 120s. What was dead was this one
 * process's pool, and only a query contending for that pool can see it.
 */

import {
  DbReachabilityTracker,
  type ReachabilityCheck,
  type ReachabilityStatus,
} from "@minsky/domain/persistence/reachability";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import type { GuardedRawSql } from "@minsky/domain/persistence/raw-sql-pooler-guard";
import { log } from "@minsky/shared/logger";

/** Resolves the container's persistence provider, or undefined when unwired. */
export type ProviderAccessor = () => PersistenceProvider | undefined;

/**
 * Issue one reachability query through the provider's SHARED raw connection.
 *
 * Exported for tests. Rejects when the provider is absent or exposes no raw SQL
 * access — both are "cannot reach the database", which is what the tracker
 * records.
 */
export async function probeViaProvider(getProvider: ProviderAccessor): Promise<unknown> {
  const provider = getProvider();
  if (!provider) throw new Error("no persistence provider is wired");
  if (typeof provider.getRawSqlConnection !== "function") {
    throw new Error("persistence provider exposes no raw SQL connection");
  }
  const raw = await provider.getRawSqlConnection();
  if (!raw) throw new Error("persistence provider returned no raw SQL connection");
  // See the module docstring: parameterized, and through `.unsafe()` so the
  // pooler guard's in-flight cap applies. `getRawSqlConnection` is declared
  // `Promise<unknown>` on the abstract base (concrete subclasses return
  // different driver types), so this narrows to the guarded shape the
  // SQL-capable provider actually hands back.
  const sql = raw as GuardedRawSql;
  return sql.unsafe("select $1::int as reachable", [1]);
}

let tracker: DbReachabilityTracker | null = null;

/**
 * Install the daemon's tracker. Idempotent per process.
 *
 * Called from the HTTP-transport boot path only: a stdio process serves no
 * `/health`, so it has no reader for this and should not be issuing probes.
 */
export function installDbReachabilityTracker(getProvider: ProviderAccessor): DbReachabilityTracker {
  tracker ??= new DbReachabilityTracker({
    probe: () => probeViaProvider(getProvider),
    // Distinguishes "the pool is wedged" (degraded) from "there is no pool"
    // (unreachable). `sql` capability is the same signal
    // `assessPersistenceHealth` uses for `connected`, so the two fields agree
    // about what is wired and disagree only about whether it ANSWERS — which is
    // exactly the distinction this task adds.
    isInitialized: () => getProvider()?.getCapabilities().sql === true,
    onLog: (message, meta) => log.warn(`[mcp-daemon] ${message}`, meta),
  });
  return tracker;
}

/**
 * Kick a probe without awaiting it, then read the PREVIOUS probe's answer.
 *
 * The non-await is the load-bearing part. Awaiting here would make `/health` as
 * slow as the database it reports on, and a wedged pool is precisely when the
 * tray most needs a fast answer — ADR-038 makes this endpoint its liveness and
 * adoption signal, and ADR-041 §Question 3 names the same anti-pattern from the
 * other side ("converts a fast local failure into a slow one, which is the worst
 * outcome for a caller on a tens-of-ms budget"). The cost is a one-poll lag into
 * and out of degraded, which `dbCheck.checkedAt` makes visible.
 *
 * Returns undefined when no tracker is installed — a stdio process, or an HTTP
 * process before boot wired one. `buildMcpHealthResponse` then emits exactly
 * what it emitted before mt#4466, rather than a false alarm.
 */
export function readDbReachability():
  | { status: ReachabilityStatus; check: ReachabilityCheck }
  | undefined {
  if (!tracker) return undefined;
  void tracker.refresh();
  return { status: tracker.getStatus(), check: tracker.getCheck() };
}

/** Test seam — drops the installed tracker so each test starts clean. */
export function __resetDbReachabilityForTests(): void {
  tracker = null;
}
