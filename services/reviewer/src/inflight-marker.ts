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
 * ## TTL rationale — the TTL bounds a HEARTBEAT, not a review (mt#4993)
 *
 * The TTL is NOT sized against how long a review takes, and must not be. A live
 * holder refreshes `expires_at` every `MARKER_HEARTBEAT_INTERVAL_MS` for as long
 * as it runs (see `startMarkerHeartbeat`), so the TTL only has to outlast a few
 * missed heartbeats. It is `3 x` the interval: one missed refresh is a hiccup,
 * three consecutive misses means the holder is gone.
 *
 * **Why it is not sized to a review.** Two failures pull the same number in
 * opposite directions, and no static value serves both:
 *
 *   - Too SHORT and a live holder expires mid-review, letting a second caller
 *     take the row over and run a duplicate review of the same PR+SHA. Measured
 *     over 30 days before this fix: 19 overlapping pairs across 18 distinct
 *     PR+SHA, 17 of them starting after the 300s TTL had elapsed, ~54 minutes of
 *     duplicated review work (mt#4993).
 *   - Too LONG and a marker orphaned by a killed process blocks every retrigger
 *     until it expires — which reads to an agent as reviewer SILENCE, a
 *     documented bypass-merge condition (mt#4267, mem#1093).
 *
 * The previous value (5 minutes) was derived from the first shape alone — "longer
 * than OpenAI's 120s model timeout plus tier-resolution overhead plus GitHub API
 * budget", which sizes ONE model call. A review is a tool LOOP of up to
 * MAX_TOOL_ROUNDS rounds, each able to spend 120s plus a 120s retry, with an
 * outer whole-review retry on top; the envelope is ~80 minutes and the measured
 * maximum review is 58. So 4% of reviews outran their own marker.
 *
 * The heartbeat resolves both directions at once rather than trading between
 * them: a live holder never expires however long it runs, and a dead one is
 * reclaimed in 180s — FASTER than the 300s it used to take.
 *
 * Configurable via REVIEWER_INFLIGHT_MARKER_TTL_MS, within bounds in ONE
 * direction. Raising it past a few heartbeat intervals re-introduces the mt#4267
 * delay for no benefit — the heartbeat, not the TTL, is what covers a long
 * review. LOWERING it below `MARKER_MIN_TTL_MS` is refused outright by
 * `resolveInflightTtlMs`, because a sub-interval TTL expires live holders
 * between beats and is the mt#4993 defect re-enabled by configuration.
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

/**
 * How often a live holder refreshes its marker (mt#4993).
 *
 * Not operator-configurable: it is an internal implementation detail of the
 * lease, and the TTL below is DERIVED from it. Exposing both invites a
 * configuration where the TTL is shorter than the interval, which expires every
 * live holder between beats — the exact bug this mechanism fixes.
 */
export const MARKER_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Missed heartbeats tolerated before a holder is presumed dead. Three: one miss
 * is a transient DB hiccup, three consecutive is a departure.
 */
export const MARKER_HEARTBEAT_MISS_TOLERANCE = 3;

/**
 * Default TTL: 3 minutes — `MARKER_HEARTBEAT_INTERVAL_MS x
 * MARKER_HEARTBEAT_MISS_TOLERANCE`, not a number chosen directly.
 *
 * Lower than the 300_000 it replaces, which is the point: with a heartbeat
 * covering long reviews, the TTL is free to shrink to what crash-detection
 * actually needs, so mt#4267's recovery latency improves by 120s at the same
 * time as mt#4993's duplicate reviews are eliminated. Read §TTL rationale above
 * before changing it.
 */
export const DEFAULT_INFLIGHT_TTL_MS =
  MARKER_HEARTBEAT_INTERVAL_MS * MARKER_HEARTBEAT_MISS_TOLERANCE;

/** Environment variable to override the TTL. */
export const INFLIGHT_TTL_ENV_VAR = "REVIEWER_INFLIGHT_MARKER_TTL_MS";

/**
 * The shortest TTL the lease can operate under (mt#4993, PR #3647 R1).
 *
 * Two heartbeat intervals: the lease needs room to miss one beat and still
 * recover on the next. A TTL at or below one interval expires every live holder
 * BETWEEN beats, which is not a degraded lease — it is the duplicate-review
 * defect this module exists to prevent, switched back on by configuration.
 */
export const MARKER_MIN_TTL_MS = MARKER_HEARTBEAT_INTERVAL_MS * 2;

/**
 * Resolve the effective TTL for inflight markers.
 *
 * Falls back to DEFAULT_INFLIGHT_TTL_MS when the env var is absent, invalid, or
 * BELOW `MARKER_MIN_TTL_MS`.
 *
 * That last clause is the one worth explaining. Before the lease, any positive
 * TTL was merely a policy choice — shorter meant faster crash recovery and more
 * mid-review expiry, and an operator could trade between them. The lease removes
 * that trade: the heartbeat now covers long reviews, so a short TTL buys nothing
 * except the failure mode. `REVIEWER_INFLIGHT_MARKER_TTL_MS=30000` against a 60s
 * beat would look like a reasonable tightening and would silently reinstate the
 * duplicate reviews this module was changed to eliminate.
 *
 * Refusing rather than clamping, deliberately, and matching this function's
 * existing convention for an invalid value: a clamp would honour part of an
 * operator's intent while quietly meaning something else, and the intent here is
 * not partially satisfiable. The warning names the floor so the operator can
 * choose a legal value rather than guess why theirs did nothing.
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
  if (parsed < MARKER_MIN_TTL_MS) {
    log.warn("inflight_marker.ttl_env_below_floor", {
      event: "inflight_marker.ttl_env_below_floor",
      envVar: INFLIGHT_TTL_ENV_VAR,
      value: parsed,
      minimum: MARKER_MIN_TTL_MS,
      heartbeatIntervalMs: MARKER_HEARTBEAT_INTERVAL_MS,
      fallback: DEFAULT_INFLIGHT_TTL_MS,
      reason:
        "a TTL below two heartbeat intervals expires live holders between beats, " +
        "reinstating the duplicate-review defect (mt#4993)",
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

/** Input for refreshMarker / startMarkerHeartbeat. */
export interface MarkerLeaseInput {
  /** The marker row's id, from AcquireSuccess. */
  markerId: string;
  /**
   * The delivery id THIS caller acquired with. Load-bearing — see refreshMarker.
   */
  deliveryId: string;
  /** TTL in milliseconds. Defaults to resolveInflightTtlMs(). */
  ttlMs?: number;
}

/**
 * Push a held marker's expiry out by one TTL (mt#4993).
 *
 * Returns true when a row was actually extended, false when this caller no
 * longer owns the marker.
 *
 * **The `delivery_id` predicate is the whole correctness argument, not a
 * belt-and-braces extra.** `acquireMarker`'s takeover is an `ON CONFLICT DO
 * UPDATE`, which updates the row IN PLACE — so the row id is STABLE across a
 * takeover and `WHERE id = ...` alone would still match after another caller has
 * claimed the marker. A heartbeat keyed on the id alone would then let a lapsed
 * holder silently steal the row back from its new owner, mid-review, producing
 * exactly the concurrent-review outcome this mechanism exists to prevent — and
 * producing it from the repair rather than from the original defect.
 *
 * `delivery_id` is re-assigned by that same DO UPDATE (`delivery_id =
 * EXCLUDED.delivery_id`), so it is the field that actually distinguishes one
 * acquisition from the next. Pairing it with the id makes the refresh a
 * conditional write that no-ops for a superseded holder.
 *
 * Never throws — the marker layer is defense in depth and a failed refresh must
 * not fail the review (the fail-open contract above). A refresh that fails
 * repeatedly ends in expiry, which is the same state as no heartbeat at all.
 */
export async function refreshMarker(db: ReviewerDb, input: MarkerLeaseInput): Promise<boolean> {
  const ttlMs = input.ttlMs ?? resolveInflightTtlMs();
  try {
    const rows = await db.execute<{ id: string }>(
      sql`UPDATE reviewer_inflight_reviews
             SET expires_at = now() + ${ttlMs} * interval '1 millisecond'
           WHERE id = ${input.markerId}
             AND delivery_id = ${input.deliveryId}
        RETURNING id`
    );
    return rows.length > 0;
  } catch (err: unknown) {
    log.warn("inflight_marker.refresh_failed", {
      event: "inflight_marker.refresh_failed",
      marker_id: input.markerId,
      delivery_id: input.deliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Injectable scheduler, so the heartbeat is testable without patching globals. */
export interface HeartbeatScheduler {
  setIntervalFn: (fn: () => void, ms: number) => unknown;
  clearIntervalFn: (handle: unknown) => void;
}

const realScheduler: HeartbeatScheduler = {
  setIntervalFn: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // Never hold the process open for a heartbeat. Without this a timer keeps
    // the event loop alive after the review finishes, so a container that
    // should exit lingers instead.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearIntervalFn: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Keep a held marker alive for as long as the caller is running (mt#4993).
 *
 * Returns a stop function; call it in the same `finally` that releases the
 * marker. Idempotent — calling it twice is a no-op.
 *
 * The refresh is fire-and-forget by design: the interval callback cannot be
 * awaited, and a slow DB must delay the review no more than it already does.
 * `refreshMarker` swallows its own errors, so nothing here can reject.
 *
 * When a refresh reports that ownership is gone, the heartbeat STOPS rather than
 * continuing to write. It has no way to reclaim the marker, and retrying would
 * only race the new owner's own heartbeat.
 */
export function startMarkerHeartbeat(
  db: ReviewerDb,
  input: MarkerLeaseInput,
  scheduler: HeartbeatScheduler = realScheduler
): () => void {
  let stopped = false;
  const handle = scheduler.setIntervalFn(() => {
    if (stopped) return;
    void refreshMarker(db, input).then((refreshed) => {
      if (refreshed || stopped) return;
      // Ownership lost — another caller took the row over after this one let it
      // lapse. Log it: this is the mt#4993 defect still occurring, and its rate
      // is the measurement that says whether the interval is tight enough.
      log.warn("inflight_marker.heartbeat_ownership_lost", {
        event: "inflight_marker.heartbeat_ownership_lost",
        marker_id: input.markerId,
        delivery_id: input.deliveryId,
      });
      stop();
    });
  }, MARKER_HEARTBEAT_INTERVAL_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    scheduler.clearIntervalFn(handle);
  }

  return stop;
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
