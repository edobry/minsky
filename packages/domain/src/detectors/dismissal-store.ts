/**
 * Dismissal store — per-project storage for dismissed Ask signatures.
 *
 * When an operator resolves a `direction.decide` Ask with a "dismiss" verdict,
 * the evidence signature is recorded here so future detections matching the
 * same signature don't re-escalate. Per mt#1035 §Calibration and dismissal.
 *
 * Scoping: dismissals are per-`repoUrl`. A dismissal in project A does not
 * suppress the same signature in project B (per mt#1035 §Open questions).
 *
 * Backed by Postgres via Drizzle. Queries are wrapped in try/catch with safe
 * defaults (false/no-op) on connection errors so detector hot paths are not
 * blocked by storage failures.
 *
 * Reference: docs/research/mt1035-system3-detector.md §Calibration and dismissal
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, count } from "drizzle-orm";
import { pgTable, text, timestamp, index, uuid } from "drizzle-orm/pg-core";
import { log } from "@minsky/shared/logger";

/**
 * Drizzle table definition for detector dismissals.
 *
 * A row records that the operator dismissed a detection with the given
 * evidence `signature` in the given `repoUrl` project. The `response`
 * field stores the operator's resolution payload (e.g. "dismiss", "snooze").
 *
 * Schema migration: src/domain/storage/migrations/pg/0030_detector_dismissals.sql
 */
export const detectorDismissalsTable = pgTable(
  "detector_dismissals",
  {
    /** UUID primary key. */
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * Evidence signature that was dismissed.
     *
     * A normalised string derived from the detector's evidence. Format is
     * detector-specific; the detector is responsible for producing a stable,
     * comparable signature from its evidence set.
     */
    signature: text("signature").notNull(),

    /**
     * Repository URL (project scoping key).
     *
     * Dismissals are isolated per project; no cross-project transfer.
     */
    repoUrl: text("repo_url").notNull(),

    /**
     * Serialised response payload from the operator.
     *
     * Opaque string; the caller passes it through as-is for audit purposes.
     */
    response: text("response").notNull(),

    /** When this dismissal was recorded. */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    bySignatureRepo: index("idx_detector_dismissals_sig_repo").on(table.signature, table.repoUrl),
  })
);

export type DismissalRecord = typeof detectorDismissalsTable.$inferSelect;
export type DismissalInsert = typeof detectorDismissalsTable.$inferInsert;

/**
 * Dismissal store — records and queries per-project dismissal signatures.
 *
 * Inject via DI or construct directly with a `PostgresJsDatabase` instance.
 * All public methods degrade gracefully (return safe defaults + log the error)
 * if the Postgres connection is unavailable.
 */
export class DismissalStore {
  constructor(private readonly db: PostgresJsDatabase) {}

  /**
   * Record that the operator dismissed a detection.
   *
   * @param signature  — normalised evidence signature (detector-produced)
   * @param repoUrl    — project scoping key
   * @param response   — operator resolution payload (serialised)
   */
  async recordDismissal(signature: string, repoUrl: string, response: string): Promise<void> {
    try {
      await this.db.insert(detectorDismissalsTable).values({ signature, repoUrl, response });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("dismissal-store: failed to record dismissal", {
        signature,
        repoUrl,
        error: message,
      });
    }
  }

  /**
   * Check whether a signature has been dismissed in the given project.
   *
   * Returns `false` on Postgres errors so the detector is not blocked by
   * storage failures (conservative: escalate rather than silently suppress).
   *
   * @param signature  — normalised evidence signature
   * @param repoUrl    — project scoping key
   */
  async isDismissed(signature: string, repoUrl: string): Promise<boolean> {
    try {
      const rows = await this.db
        .select({ count: count() })
        .from(detectorDismissalsTable)
        .where(
          and(
            eq(detectorDismissalsTable.signature, signature),
            eq(detectorDismissalsTable.repoUrl, repoUrl)
          )
        );

      const row = rows[0];
      return row !== undefined && row.count > 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("dismissal-store: failed to check dismissal, returning false", {
        signature,
        repoUrl,
        error: message,
      });
      return false;
    }
  }

  /**
   * Count dismissals for a given signature in the given project.
   *
   * Used by the severity-downgrade module to compute dismissal rates.
   * Returns `0` on Postgres errors.
   *
   * @param signature  — normalised evidence signature
   * @param repoUrl    — project scoping key
   */
  async countDismissals(signature: string, repoUrl: string): Promise<number> {
    try {
      const rows = await this.db
        .select({ count: count() })
        .from(detectorDismissalsTable)
        .where(
          and(
            eq(detectorDismissalsTable.signature, signature),
            eq(detectorDismissalsTable.repoUrl, repoUrl)
          )
        );

      const row = rows[0];
      return row !== undefined ? row.count : 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("dismissal-store: failed to count dismissals, returning 0", {
        signature,
        repoUrl,
        error: message,
      });
      return 0;
    }
  }
}

/**
 * In-memory dismissal store for tests and non-Postgres contexts.
 *
 * Stores dismissals in a `Map<repoUrl, Set<signature>>`. Not persistent;
 * use only in tests or where Postgres is unavailable.
 */
export class InMemoryDismissalStore {
  private readonly store = new Map<string, Map<string, number>>();

  async recordDismissal(signature: string, repoUrl: string, _response: string): Promise<void> {
    let repoMap = this.store.get(repoUrl);
    if (repoMap === undefined) {
      repoMap = new Map();
      this.store.set(repoUrl, repoMap);
    }
    repoMap.set(signature, (repoMap.get(signature) ?? 0) + 1);
  }

  async isDismissed(signature: string, repoUrl: string): Promise<boolean> {
    return (this.store.get(repoUrl)?.get(signature) ?? 0) > 0;
  }

  async countDismissals(signature: string, repoUrl: string): Promise<number> {
    return this.store.get(repoUrl)?.get(signature) ?? 0;
  }
}

/**
 * Union type for stores that can satisfy the dismissal interface.
 * Allows code that doesn't care about the backend to accept either.
 */
export type AnyDismissalStore = Pick<
  DismissalStore,
  "recordDismissal" | "isDismissed" | "countDismissals"
>;
