/**
 * Schema readiness — is the database current with the code that is running?
 *
 * ## Why this exists (mt#3297)
 *
 * When a PR carrying a migration merges, the tray's backend watcher (mt#2299)
 * restarts the daemon on the source change within seconds. The migration is NOT
 * applied by that restart — applying to a shared database is deliberately an
 * authorized, explicit act. So there is a window where the code in memory
 * requires columns the database does not have.
 *
 * Observed 2026-07-28/29 with mt#3278's migration 0076: every transcript ingest
 * failed with `column "ingest_quarantined_at" does not exist`, for hours, while
 * the daemon reported itself healthy. `~/.local/state/minsky/logs/` grew ~500 MB
 * and stopped the moment the migration landed. Nothing self-healed; the window
 * closed only because a human was watching.
 *
 * ## What this does and does not do
 *
 * It makes the condition LEGIBLE and STOPS schema-dependent work — it does not
 * self-heal. Auto-applying a migration from a file-watcher-triggered restart is
 * the wrong posture for shared state; the remedy is an authorized
 * `persistence migrate --execute`, and this exists so an operator learns that is
 * needed from one clear signal instead of a flood of column-does-not-exist
 * errors.
 *
 * Two consumers, one source of truth:
 *
 *  - `/api/health` reports the `schema` block. The status code cannot carry this
 *    — the daemon starts fine and answers 200 in both states — so the BODY has
 *    to say it (mt#3148: a probe that cannot fail carries no information).
 *  - Schema-dependent sweeps call {@link isSchemaBehind} and skip with a single
 *    logged reason, instead of failing once per session.
 *
 * That subsystem-level bound is the only place this CAN be bounded. mt#3278's
 * per-session quarantine cannot cover it: the quarantine write targets the very
 * columns that are missing, so during the incident the failure counter could
 * never be recorded and no session ever reached the threshold.
 */
import { isSqlCapable } from "@minsky/domain/persistence/types";
import { readFileSync } from "fs";
import { join } from "path";

import { log } from "@minsky/shared/logger";
import { describePersistenceUnavailability } from "@minsky/domain/persistence/unconfigured-provider";

/** Snapshot of how the database's schema compares to what this build expects. */
export interface SchemaReadiness {
  /**
   * True when every migration this build ships has been applied.
   *
   * `null` when readiness could not be determined (no SQL-capable persistence,
   * or the check itself failed). Deliberately tri-state: "we do not know" must
   * not be reported as "current", or this becomes another probe that cannot
   * fail.
   */
  current: boolean | null;
  /** Migration tags this build ships that the database has not applied. */
  pending: string[];
  /** ISO timestamp of the last successful check, or null if never checked. */
  checkedAt: string | null;
  /** Why readiness is unknown, when `current` is null. */
  unknownReason?: string;
}

const UNCHECKED: SchemaReadiness = { current: null, pending: [], checkedAt: null };

// epoch-exempt: plain data, not a provider-derived handle (mt#3721). `state` is
// a snapshot of migration readiness — booleans, ids, a timestamp — recomputed by
// this module's own periodic check. It holds no connection, so a pool recycle
// cannot invalidate it: the schema of the database being described does not
// change when the client pool is torn down and rebuilt.
let state: SchemaReadiness = UNCHECKED;

/** Current readiness snapshot, for `/api/health`. */
export function getSchemaReadiness(): SchemaReadiness {
  return { ...state, pending: [...state.pending] };
}

/**
 * True only when the schema is KNOWN to be behind.
 *
 * Unknown readiness returns false — a sweep must not be disabled because the
 * readiness check itself could not run. That direction fails open on purpose:
 * the cost of a sweep running against a current schema it could not verify is
 * zero, while the cost of silently disabling capture on an unknown is another
 * quiet outage.
 */
export function isSchemaBehind(): boolean {
  return state.current === false;
}

/** Reset to the unchecked state. Tests only. */
export function resetSchemaReadiness(): void {
  state = UNCHECKED;
}

/** Result of {@link decideBehindTransitionSignal}. */
export interface SchemaTransitionSignal {
  /** True only when this tick should emit the "entered behind" warn line. */
  shouldSignal: boolean;
}

/**
 * Pure transition decision for the "entered behind" warn line (PR #2379 R1;
 * extracted mt#3629 / mt#3565 §Reframe).
 *
 * The gate runs on every sweep tick, so a naive "warn whenever behind" would
 * itself become the unbounded-log-volume problem this module exists to
 * prevent. The decision is a pure function of the previous and next
 * behind-state: signal only on the FALSE → TRUE edge, not on every tick the
 * condition persists.
 */
export function decideBehindTransitionSignal(
  wasBehind: boolean,
  isBehind: boolean
): SchemaTransitionSignal {
  return { shouldSignal: isBehind && !wasBehind };
}

/**
 * Dependencies for {@link refreshSchemaReadiness}, injectable so the check can
 * be tested without a database or a real migrations folder.
 */
export interface SchemaReadinessDeps {
  /**
   * Returns the migration tags this build ships that are NOT applied in the DB.
   * Throws if the comparison cannot be made.
   */
  readPendingMigrations: () => Promise<string[]>;
  /**
   * Injectable sink for the "entered behind" warn line, defaulting to the
   * shared logger. Tests inject a fake here instead of spying on the logger
   * module (mt#3629) — the shell's only job is forwarding what the pure core
   * in {@link decideBehindTransitionSignal} decided.
   */
  logBehindTransition?: (message: string, meta: { pending: string[] }) => void;
  /**
   * Injectable sink for the "now current" recovery line, defaulting to the
   * shared logger.
   */
  logRecovered?: (message: string) => void;
}

/**
 * Recompute readiness. Safe to call repeatedly; never throws.
 *
 * Called at daemon boot and before each schema-dependent sweep, so that a
 * migration applied while the daemon is running lifts the block on the next
 * tick with no restart — the recovery path an operator will actually take.
 */
export async function refreshSchemaReadiness(deps: SchemaReadinessDeps): Promise<SchemaReadiness> {
  try {
    const pending = await deps.readPendingMigrations();
    const wasBehind = state.current === false;
    const isBehind = pending.length > 0;
    state = {
      current: pending.length === 0,
      pending,
      checkedAt: new Date().toISOString(),
    };

    // Log the TRANSITION into behind, not every check (PR #2379 R1). This runs
    // on every sweep tick, and a check that exists to bound log volume must
    // not itself become the thing writing a line every 30 minutes forever. The
    // condition stays continuously visible on /api/health, which is the
    // surface built for standing state; the log is for the event. The decision
    // itself is the pure core above — this shell only forwards it.
    const { shouldSignal } = decideBehindTransitionSignal(wasBehind, isBehind);
    if (shouldSignal) {
      const logBehindTransition = deps.logBehindTransition ?? log.warn;
      logBehindTransition(
        `cockpit: database schema is BEHIND this build — ${pending.length} migration(s) not applied. ` +
          `Schema-dependent sweeps are paused until this is resolved. ` +
          `Run 'minsky persistence migrate --execute'.`,
        { pending }
      );
    } else if (!isBehind && wasBehind) {
      // Only on the transition, so the common case stays quiet.
      const logRecovered = deps.logRecovered ?? log.cli;
      logRecovered("cockpit: database schema is now current — schema-dependent sweeps resumed.");
    }
    return getSchemaReadiness();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = {
      current: null,
      pending: [],
      checkedAt: state.checkedAt,
      unknownReason: message,
    };
    log.warn("cockpit: could not determine schema readiness; proceeding without the check", {
      message,
    });
    return getSchemaReadiness();
  }
}

/**
 * Production wiring: compare the migration journal this build ships against the
 * hashes recorded in `drizzle.__drizzle_migrations`.
 *
 * Uses `resolvePendingMigrations`, the same per-migration hash SET DIFFERENCE
 * the migrate command uses, rather than comparing counts. A count comparison
 * has the mirror of the bug this module exists to fix (PR #2379 R1): it assumes
 * the ledger is a prefix of the journal, so a migration missing from the MIDDLE
 * of an otherwise-full ledger reads as "current" — a silent false-negative in a
 * check whose whole purpose is to stop silent schema mismatches. mt#2936 fixed
 * exactly that class in the migrate path; borrowing its resolver rather than
 * re-deriving a weaker comparison here is the point.
 *
 * Also reports the OPPOSITE divergence: applied hashes this build's journal does
 * not contain, which means the database is AHEAD of the running code (stale
 * deploy, or a rollback of the code but not the schema). That does not pause
 * sweeps — the columns the code wants do exist — but it is a schema mismatch an
 * operator should see rather than have silently reported as healthy.
 */
export async function refreshSchemaReadinessFromDb(): Promise<SchemaReadiness> {
  return refreshSchemaReadiness({
    readPendingMigrations: async () => {
      const { resolvePgMigrationsFolder, resolvePendingMigrations, computeMigrationHash } =
        await import("@minsky/domain/persistence/postgres-migration-operations");
      const { getSharedPersistenceService } = await import("./shared-persistence");
      const { sql: drizzleSql } = await import("drizzle-orm");

      // Same accessor the transcript sweep itself uses, so readiness is judged
      // against the connection the gated work would actually run on.
      const svc = await getSharedPersistenceService();
      const provider = svc.getProvider();
      // Capability + method, via the one guard (mt#4543).
      if (!isSqlCapable(provider)) {
        // Provider already in hand — domain helper directly (mt#3661).
        throw new Error(
          `schema readiness cannot be judged — ${describePersistenceUnavailability(provider)}`
        );
      }
      const db = await (
        provider as {
          getDatabaseConnection: () => Promise<{
            execute: (q: unknown) => Promise<unknown>;
          } | null>;
        }
      ).getDatabaseConnection();
      if (!db) throw new Error("no database connection available");

      const folder = resolvePgMigrationsFolder();
      const journal = JSON.parse(
        String(readFileSync(join(folder, "meta", "_journal.json"), "utf-8"))
      ) as { entries: Parameters<typeof resolvePendingMigrations>[0] };

      const rows = (await db.execute(
        drizzleSql`SELECT hash FROM "drizzle"."__drizzle_migrations"`
      )) as Array<{ hash: string | null }>;
      const appliedHashes = new Set(rows.map((r) => r.hash).filter((h): h is string => Boolean(h)));

      // Journal entries whose file hash is absent from the ledger — the
      // migrations this build ships that the database has not applied.
      const pending = resolvePendingMigrations(journal.entries, folder, appliedHashes);

      // The other direction: ledger hashes this build's journal does not
      // contain. Reported, not blocking — the running code's columns exist, but
      // a DB ahead of the code is still a mismatch worth seeing.
      const journalHashes = new Set(
        journal.entries.map((entry) => {
          try {
            return computeMigrationHash(
              String(readFileSync(join(folder, `${entry.tag}.sql`), "utf-8"))
            );
          } catch {
            return "";
          }
        })
      );
      const aheadCount = [...appliedHashes].filter((h) => !journalHashes.has(h)).length;
      if (aheadCount > 0) {
        log.warn(
          `cockpit: database has ${aheadCount} applied migration(s) this build does not ship — ` +
            `the DB is AHEAD of the running code (stale deploy?). Not pausing sweeps.`,
          { aheadCount }
        );
      }

      return pending.map((entry) => entry.tag);
    },
  });
}
