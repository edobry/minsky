/**
 * Presence claim repository — interface + Drizzle/Postgres implementation.
 *
 * The PresenceClaimRepository interface is the domain contract.
 * DrizzlePresenceClaimRepository is the Postgres implementation.
 *
 * Operations:
 *   upsertClaim    — insert or refresh (keyed on unique tuple)
 *   listClaims     — list claims for a subject, annotated with stale flag
 *   reapStale      — delete claims older than a given threshold
 *
 * Reference: mt#2562 — task-grain presence/claim.
 * Models: packages/domain/src/ask/repository.ts
 */

import { and, desc, eq, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { presenceClaimsTable } from "../storage/schemas/presence-claims-schema";
import type { PresenceClaimRecord } from "../storage/schemas/presence-claims-schema";
import type {
  PresenceClaim,
  AnnotatedPresenceClaim,
  UpsertPresenceClaimInput,
  PresenceSubjectKind,
} from "./types";
import { PRESENCE_CLAIM_TTL_MS } from "./types";

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw Drizzle row to the typed domain PresenceClaim.
 * @internal Exported for unit testing only.
 */
export function toPresenceClaim(row: PresenceClaimRecord): PresenceClaim {
  return {
    id: row.id,
    subjectKind: row.subjectKind as PresenceSubjectKind,
    subjectId: row.subjectId,
    actorId: row.actorId,
    ccConversationId: row.ccConversationId ?? undefined,
    tty: row.tty ?? undefined,
    host: row.host ?? undefined,
    sessionId: row.sessionId ?? undefined,
    projectId: row.projectId ?? undefined,
    claimedAt: row.claimedAt.toISOString(),
    lastRefreshedAt: row.lastRefreshedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Domain contract for PresenceClaim persistence.
 *
 * All consumers depend on this interface, not on the concrete Drizzle
 * implementation, so tests can inject fakes.
 */
export interface PresenceClaimRepository {
  /**
   * Insert a new claim, or refresh lastRefreshedAt if (subjectKind, subjectId, actorId)
   * already exists. Returns the upserted claim.
   */
  upsertClaim(input: UpsertPresenceClaimInput): Promise<PresenceClaim>;

  /**
   * List all claims for the given subject, annotated with a staleness flag.
   *
   * @param subjectKind  Grain discriminator.
   * @param subjectId    Normalized subject identifier.
   * @param staleThresholdMs  Age in ms past which a claim is considered stale.
   *                         Defaults to PRESENCE_CLAIM_TTL_MS (15m).
   */
  listClaims(
    subjectKind: PresenceSubjectKind,
    subjectId: string,
    staleThresholdMs?: number
  ): Promise<AnnotatedPresenceClaim[]>;

  /**
   * Delete claims whose last_refreshed_at is older than olderThanMs milliseconds.
   * Returns the count of deleted rows.
   */
  reapStale(olderThanMs: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Drizzle / Postgres implementation
// ---------------------------------------------------------------------------

export class DrizzlePresenceClaimRepository implements PresenceClaimRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async upsertClaim(input: UpsertPresenceClaimInput): Promise<PresenceClaim> {
    const now = new Date();

    // ON CONFLICT on the unique tuple: update the mutable where-context columns
    // and refresh last_refreshed_at. claimed_at is intentionally NOT updated
    // (it records when the claim was first made).
    const rows = await this.db
      .insert(presenceClaimsTable)
      .values({
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        actorId: input.actorId,
        ccConversationId: input.ccConversationId ?? null,
        tty: input.tty ?? null,
        host: input.host ?? null,
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        claimedAt: now,
        lastRefreshedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          presenceClaimsTable.subjectKind,
          presenceClaimsTable.subjectId,
          presenceClaimsTable.actorId,
        ],
        set: {
          ccConversationId: input.ccConversationId ?? null,
          tty: input.tty ?? null,
          host: input.host ?? null,
          sessionId: input.sessionId ?? null,
          projectId: input.projectId ?? null,
          lastRefreshedAt: now,
        },
      })
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error("upsertClaim: no row returned after upsert");
    }
    return toPresenceClaim(row);
  }

  async listClaims(
    subjectKind: PresenceSubjectKind,
    subjectId: string,
    staleThresholdMs: number = PRESENCE_CLAIM_TTL_MS
  ): Promise<AnnotatedPresenceClaim[]> {
    const rows = await this.db
      .select()
      .from(presenceClaimsTable)
      .where(
        and(
          eq(presenceClaimsTable.subjectKind, subjectKind),
          eq(presenceClaimsTable.subjectId, subjectId)
        )
      )
      .orderBy(desc(presenceClaimsTable.lastRefreshedAt));

    const staleThreshold = new Date(Date.now() - staleThresholdMs);

    return rows.map((row) => ({
      ...toPresenceClaim(row),
      stale: row.lastRefreshedAt < staleThreshold,
    }));
  }

  async reapStale(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);

    const result = await this.db
      .delete(presenceClaimsTable)
      .where(lt(presenceClaimsTable.lastRefreshedAt, cutoff))
      .returning({ id: presenceClaimsTable.id });

    return result.length;
  }
}

// ---------------------------------------------------------------------------
// Helper: build a repository from a raw DB connection (for fire-and-forget callers)
// ---------------------------------------------------------------------------

/**
 * Build a DrizzlePresenceClaimRepository from a raw database connection.
 * Returns null if the db is absent or not a PostgresJsDatabase.
 */
export function buildPresenceClaimRepository(db: unknown): DrizzlePresenceClaimRepository | null {
  if (!db) return null;
  // Duck-type check: PostgresJsDatabase has a `select` method
  if (typeof (db as Record<string, unknown>).select !== "function") return null;
  return new DrizzlePresenceClaimRepository(db as PostgresJsDatabase);
}
