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
import { readFileSync } from "fs";
import { join } from "path";

import { log } from "@minsky/shared/logger";

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
    state = {
      current: pending.length === 0,
      pending,
      checkedAt: new Date().toISOString(),
    };

    if (pending.length > 0) {
      log.warn(
        `cockpit: database schema is BEHIND this build — ${pending.length} migration(s) not applied. ` +
          `Schema-dependent sweeps are paused. Run 'minsky persistence migrate --execute'.`,
        { pending }
      );
    } else if (wasBehind) {
      // Only on the transition, so the common case stays quiet.
      log.cli("cockpit: database schema is now current — schema-dependent sweeps resumed.");
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
 * count recorded in `drizzle.__drizzle_migrations`.
 *
 * Count-based rather than hash-based on purpose. The question here is only
 * "does the running code expect columns the DB lacks", which a shortfall in the
 * applied count answers; the richer per-migration hash comparison
 * (`resolvePendingMigrations`) exists for the migrate command, which needs to
 * know WHICH files to run and to detect edited-after-apply drift. Borrowing it
 * would couple a health check to the migrate path's file reads and its
 * immutable-migration semantics for no gain at this question.
 */
export async function refreshSchemaReadinessFromDb(): Promise<SchemaReadiness> {
  return refreshSchemaReadiness({
    readPendingMigrations: async () => {
      const { resolvePgMigrationsFolder } = await import(
        "@minsky/domain/persistence/postgres-migration-operations"
      );
      const { getSharedPersistenceService } = await import("./shared-persistence");
      const { sql: drizzleSql } = await import("drizzle-orm");

      // Same accessor the transcript sweep itself uses, so readiness is judged
      // against the connection the gated work would actually run on.
      const svc = await getSharedPersistenceService();
      const provider = svc.getProvider();
      if (
        !("getDatabaseConnection" in provider) ||
        typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !==
          "function"
      ) {
        throw new Error("persistence provider is not SQL-capable");
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
      ) as { entries: { tag: string }[] };

      const result = (await db.execute(
        drizzleSql`SELECT COUNT(*)::text as count FROM "drizzle"."__drizzle_migrations"`
      )) as Array<{ count: string }>;
      const appliedCount = Number.parseInt(result?.[0]?.count ?? "0", 10);

      // Journal entries beyond what the ledger records are the ones this build
      // has and the DB does not.
      return journal.entries.slice(appliedCount).map((e) => e.tag);
    },
  });
}
