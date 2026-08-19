/**
 * In-flight marker helpers for the sweeper-vs-webhook double-trigger race (mt#1907).
 *
 * The marker is a row in reviewer_inflight_reviews. A caller acquires the marker
 * by inserting a row with a unique (owner, repo, pr_number, head_sha) key.
 * INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at < now() RETURNING id is
 * the concurrency primitive:
 *   - Non-empty RETURNING → caller acquired the marker (it is now the owner),
 *     either by inserting a fresh row or by taking over an EXPIRED one.
 *   - Empty RETURNING → another caller holds a LIVE marker.
 *
 * On runReview exit (success or error), the owner calls releaseMarker to DELETE
 * the row. The sweeper prunes stale markers (expires_at < now()) at the top of
 * each cycle as a defense-in-depth safety net for crashed runReview calls that
 * never released their marker.
 *
 * ## Two enforcement points for expiry, not one (mt#4267)
 *
 * The conditional takeover above and pruneStaleMarkers are BOTH expiry
 * enforcement, at different moments, and both are load-bearing:
 *
 *   - acquire-time (this module's ON CONFLICT ... WHERE) makes a stale marker
 *     recoverable by the NEXT caller, whichever entry point that is.
 *   - sweep-time (pruneStaleMarkers) reclaims rows for PRs nobody retriggers,
 *     so the table does not accumulate orphans indefinitely.
 *
 * Neither subsumes the other: the sweeper only reaches PRs its own cycle
 * selects, and acquire-time only reaches PRs someone asks about. Removing the
 * prune would leak rows; removing the takeover reintroduces mt#4267, where a
 * marker orphaned by a killed process blocked every direct retrigger for up to
 * a full sweeper cadence.
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
 * Uses INSERT ... ON CONFLICT (owner, repo, pr_number, head_sha) DO UPDATE ...
 * WHERE expires_at < now() RETURNING id as the concurrency primitive:
 *   - Non-empty result → this caller acquired the marker; returns { acquired: true, id }.
 *     Covers both a fresh insert and the takeover of an EXPIRED row (mt#4267).
 *   - Empty result → another caller holds a LIVE marker; returns { acquired: false, heldBy }.
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

  // INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at < now() RETURNING id.
  // Drizzle doesn't expose ON CONFLICT with RETURNING via typed helpers, so this
  // is raw SQL.
  //
  // mt#4267: the conflict action is a CONDITIONAL takeover rather than DO NOTHING.
  // A LIVE row fails the WHERE, so Postgres updates nothing and RETURNING is empty
  // — byte-identical behaviour to the old DO NOTHING, which is what keeps mt#1907's
  // AT-4/AT-5 (two live acquirers, exactly one wins) true by construction. An
  // EXPIRED row is taken over in the SAME statement, which is the whole point: a
  // prune-then-insert pair would reopen the very race this marker exists to close.
  //
  // Without this, expiry was enforced in exactly one place — pruneStaleMarkers, run
  // by the sweeper at the top of its cycle. That was sufficient when the sweeper and
  // the webhook were the only two entry points, and stopped being sufficient when
  // POST /retrigger (mt#2127/mt#2346) was added: it reaches runReview directly and
  // never prunes, so a marker orphaned by a killed process refused every retrigger
  // until the sweeper's next cycle happened to sweep it (SWEEPER_INTERVAL_MS, 10 min
  // by default). Observed 2026-08-18: a redeploy killed a review in flight and a
  // retrigger 16 minutes later — 11 minutes past the 5-minute TTL — was still
  // refused with `concurrent_inflight`.
  //
  // RETURNING gives the EXISTING row's id on a takeover (DO UPDATE updates in place),
  // so the new owner releases the same row it took over.
  const rows = await db.execute<{ id: string }>(
    sql`INSERT INTO reviewer_inflight_reviews
          (owner, repo, pr_number, head_sha, acquired_by, delivery_id, acquired_at, expires_at)
        VALUES
          (${owner}, ${repo}, ${prNumber}, ${headSha}, ${acquiredBy}, ${deliveryId},
           now(), now() + ${ttlMs} * interval '1 millisecond')
        ON CONFLICT (owner, repo, pr_number, head_sha) DO UPDATE
          SET acquired_by = EXCLUDED.acquired_by,
              delivery_id = EXCLUDED.delivery_id,
              acquired_at = EXCLUDED.acquired_at,
              expires_at  = EXCLUDED.expires_at
          WHERE reviewer_inflight_reviews.expires_at < now()
        RETURNING id`
  );

  const firstRow = rows[0];
  if (firstRow !== undefined && firstRow.id) {
    return { acquired: true, id: firstRow.id };
  }

  // The conflict action matched nothing — a LIVE marker holds the key. Fetch
  // heldBy for the log.
  //
  // The `gt(expiresAt, now)` filter below is deliberate and, since mt#4267, says
  // what it means: a null heldBy is now a genuine race (the row expired between
  // the upsert and this select), not the routine stale-row case. Before the
  // conditional takeover it was the routine case — a refusal against an expired
  // row logged `acquired_by: null`, a marker held by nobody, which is the tell
  // that distinguishes the mt#4267 defect from an ordinary concurrent review.
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
