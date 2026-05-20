/**
 * In-flight marker helpers for the sweeper-vs-webhook double-trigger race (mt#1907).
 *
 * The marker is a row in reviewer_inflight_reviews. A caller acquires the marker
 * by inserting a row with a unique (owner, repo, pr_number, head_sha) key.
 * INSERT ... ON CONFLICT DO NOTHING RETURNING id is the concurrency primitive:
 *   - Non-empty RETURNING → caller acquired the marker (it is now the owner).
 *   - Empty RETURNING → another caller already holds it.
 *
 * On runReview exit (success or error), the owner calls releaseMarker to DELETE
 * the row. The sweeper prunes stale markers (expires_at < now()) at the top of
 * each cycle as a defense-in-depth safety net for crashed runReview calls that
 * never released their marker.
 *
 * ## TTL rationale
 *
 * Default TTL is 5 minutes, intentionally longer than OpenAI's 120s model
 * timeout plus tier-resolution overhead plus GitHub API budget. Configurable
 * via REVIEWER_INFLIGHT_MARKER_TTL_MS. When a runReview crashes without
 * releasing its marker, the sweeper will NOT retrigger the PR until the marker
 * expires. A crash that leaves a fresh marker will therefore delay retrigger
 * by up to TTL. This is acceptable: the sweeper is a best-effort safety net,
 * not a hard SLA.
 *
 * ## Fail-open contract (SC #6)
 *
 * When acquireMarker throws (DB unreachable, schema mismatch, etc.), the caller
 * MUST proceed without the marker guarantee. The marker layer is defense in
 * depth; failing closed would make the reviewer service DB-availability
 * dependent, which is worse than the race it prevents.
 */

import { sql, and, or, eq, gt } from "drizzle-orm";
import type { ReviewerDb } from "./db/client";
import { inflightReviewsTable } from "./db/schemas/inflight-reviews-schema";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL: 5 minutes in milliseconds. */
export const DEFAULT_INFLIGHT_TTL_MS = 300_000;

/** Environment variable to override the TTL. */
export const INFLIGHT_TTL_ENV_VAR = "REVIEWER_INFLIGHT_MARKER_TTL_MS";

/**
 * Resolve the effective TTL for inflight markers.
 * Falls back to DEFAULT_INFLIGHT_TTL_MS when the env var is absent or invalid.
 */
export function resolveInflightTtlMs(): number {
  const raw = process.env[INFLIGHT_TTL_ENV_VAR];
  if (!raw) return DEFAULT_INFLIGHT_TTL_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.warn("inflight_marker.invalid_ttl_env", {
      event: "inflight_marker.invalid_ttl_env",
      envVar: INFLIGHT_TTL_ENV_VAR,
      value: raw,
      fallback: DEFAULT_INFLIGHT_TTL_MS,
    });
    return DEFAULT_INFLIGHT_TTL_MS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Details about the marker held by the winner (when acquire fails). */
export interface MarkerInfo {
  id: string;
  acquiredBy: string;
  deliveryId: string;
  expiresAt: Date;
}

/** Successful acquire result — caller is now the marker owner. */
export interface AcquireSuccess {
  acquired: true;
  id: string;
}

/** Failed acquire result — another caller holds the marker. */
export interface AcquireFailure {
  acquired: false;
  /** The acquired_by field from the existing marker, if retrievable. */
  heldBy: string | null;
}

export type AcquireResult = AcquireSuccess | AcquireFailure;

/** Input for acquireMarker. */
export interface AcquireMarkerInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  /** 'webhook' or 'sweeper' — identifies which code path acquired the marker. */
  acquiredBy: string;
  /** GitHub delivery ID or synthesized sweeper delivery ID for audit linkage. */
  deliveryId: string;
  /** TTL in milliseconds. Defaults to resolveInflightTtlMs(). */
  ttlMs?: number;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire the inflight marker for a (owner, repo, prNumber, headSha) tuple.
 *
 * Uses INSERT ... ON CONFLICT (owner, repo, pr_number, head_sha) DO NOTHING RETURNING id
 * as the concurrency primitive:
 *   - Non-empty result → this caller acquired the marker; returns { acquired: true, id }.
 *   - Empty result → another caller holds it; returns { acquired: false, heldBy }.
 *
 * Callers MUST wrap this in try/catch and proceed without the marker on DB errors
 * (fail-open contract per SC #6).
 */
export async function acquireMarker(
  db: ReviewerDb,
  input: AcquireMarkerInput
): Promise<AcquireResult> {
  const { owner, repo, prNumber, headSha, acquiredBy, deliveryId } = input;
  const ttlMs = input.ttlMs ?? resolveInflightTtlMs();

  // Use INSERT ... ON CONFLICT DO NOTHING RETURNING id.
  // Drizzle doesn't expose ON CONFLICT DO NOTHING with RETURNING via typed helpers,
  // so we use raw SQL for this single statement.
  const rows = await db.execute<{ id: string }>(
    sql`INSERT INTO reviewer_inflight_reviews
          (owner, repo, pr_number, head_sha, acquired_by, delivery_id, acquired_at, expires_at)
        VALUES
          (${owner}, ${repo}, ${prNumber}, ${headSha}, ${acquiredBy}, ${deliveryId},
           now(), now() + ${ttlMs} * interval '1 millisecond')
        ON CONFLICT (owner, repo, pr_number, head_sha) DO NOTHING
        RETURNING id`
  );

  const firstRow = rows[0];
  if (firstRow !== undefined && firstRow.id) {
    return { acquired: true, id: firstRow.id };
  }

  // ON CONFLICT fired — another caller holds the marker. Fetch heldBy for the log.
  let heldBy: string | null = null;
  try {
    const existing = await db
      .select({ acquiredBy: inflightReviewsTable.acquiredBy })
      .from(inflightReviewsTable)
      .where(
        and(
          eq(inflightReviewsTable.owner, owner),
          eq(inflightReviewsTable.repo, repo),
          eq(inflightReviewsTable.prNumber, prNumber),
          eq(inflightReviewsTable.headSha, headSha),
          gt(inflightReviewsTable.expiresAt, new Date())
        )
      )
      .limit(1);
    const existingRow = existing[0];
    heldBy = existingRow !== undefined ? existingRow.acquiredBy : null;
  } catch {
    // Non-fatal: we already know acquisition failed; heldBy is best-effort.
  }

  return { acquired: false, heldBy };
}

/**
 * Release the inflight marker by id.
 *
 * Idempotent: deleting a non-existent row is a no-op.
 * Callers should call this in a finally block to ensure release even on errors.
 */
export async function releaseMarker(db: ReviewerDb, markerId: string): Promise<void> {
  await db.execute(sql`DELETE FROM reviewer_inflight_reviews WHERE id = ${markerId}`);
}

/**
 * Prune stale markers (expires_at < now()).
 *
 * Called at the top of each sweep cycle as a defense-in-depth safety net
 * for runReview calls that crashed without releasing their marker.
 *
 * Returns the count of rows deleted.
 */
export async function pruneStaleMarkers(db: ReviewerDb): Promise<number> {
  const rows = await db.execute<{ id: string }>(
    sql`DELETE FROM reviewer_inflight_reviews WHERE expires_at < now() RETURNING id`
  );
  return rows.length;
}

/**
 * Bulk lookup: return a Map keyed by "${owner}/${repo}#${prNumber}@${headSha}"
 * for each active (non-expired) marker matching the given PRs.
 *
 * Used by the sweeper to filter out PRs that are already being reviewed.
 * PRs without a marker are absent from the map.
 */
export async function listActiveMarkersForPRs(
  db: ReviewerDb,
  prs: Array<{ owner: string; repo: string; prNumber: number; headSha: string }>
): Promise<Map<string, MarkerInfo>> {
  if (prs.length === 0) return new Map();

  const result = new Map<string, MarkerInfo>();

  // Batch lookup: OR together all (owner, repo, pr_number, head_sha) tuples.
  // For typical sweeper batch sizes (≤20 PRs) this is fine.
  const conditions = prs.map((pr) =>
    and(
      eq(inflightReviewsTable.owner, pr.owner),
      eq(inflightReviewsTable.repo, pr.repo),
      eq(inflightReviewsTable.prNumber, pr.prNumber),
      eq(inflightReviewsTable.headSha, pr.headSha)
    )
  );

  const rows = await db
    .select()
    .from(inflightReviewsTable)
    .where(and(gt(inflightReviewsTable.expiresAt, new Date()), or(...conditions)));

  for (const row of rows) {
    const key = markerKey(row.owner, row.repo, row.prNumber, row.headSha);
    result.set(key, {
      id: row.id,
      acquiredBy: row.acquiredBy,
      deliveryId: row.deliveryId,
      expiresAt: row.expiresAt,
    });
  }

  return result;
}

/**
 * Build the lookup key for a PR in the marker map returned by listActiveMarkersForPRs.
 *
 * Exported so callers use the same format as the implementation.
 */
export function markerKey(owner: string, repo: string, prNumber: number, headSha: string): string {
  return `${owner}/${repo}#${prNumber}@${headSha}`;
}
