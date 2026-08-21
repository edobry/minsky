/**
 * Sweep-time claims on a calibration log (mt#4164).
 *
 * Two `/calibration-review` passes classifying the same window is pure waste:
 * both agents read the same records, both file findings, and only one ack can
 * survive. The skill has carried a prose probe against this since R1 — "search
 * for a tune task or disposition ask already filed against the detectors you are
 * about to review" — and it has now failed three times.
 *
 * ## Why the prose probe cannot work, and this can
 *
 * The probe searches for ARTIFACTS. A pass that is mid-classification has not
 * filed one yet, so there is nothing to find — and classification is the entire
 * expensive part, all of it upstream of the artifact. R3 (2026-08-16) is the
 * clean demonstration: two passes over the same `bare-entity-ref` window, filed
 * one minute apart, and the earlier pass was invisible to the later one's probe
 * because it had produced nothing yet. Relocating the probe (R2, mt#4119) moved
 * it to the right place in the skill; placement was never the binding constraint.
 *
 * A claim is visible from the moment the work STARTS, which is the only signal
 * that can answer "is someone doing this right now".
 *
 * ## Derived, never stored
 *
 * `presence.ts` states the principle this module obeys: *"a stored
 * `presence = 'LIVE'` is a claim no writer can retract when the process dies
 * mid-tool-call."* The same is true here — a pass killed mid-classification
 * would hold its log forever. So nothing stores "locked": the record is an
 * OBSERVATION (who, when, last refreshed) and freshness is DERIVED from elapsed
 * time at read, so a dead holder ages out for free with no reaper to write.
 *
 * ## Why a repo-local file rather than `presence_claims`
 *
 * The `presence_claims` table is grain-agnostic and would have accepted a fourth
 * `subject_kind`. It is deliberately not used, for two reasons:
 *
 *  - The sweep is filesystem-only today — watermarks live in
 *    `.minsky/calibration-review-watermarks.json` under a mkdir lock, and the
 *    sweep runs in hook and CLI contexts that have no database bootstrap. A DB
 *    dependency would make the claim less available than the work it guards.
 *  - `presence_claims` backs an operator-facing fleet-state surface. A claim on
 *    a calibration log is internal coordination between passes; putting it there
 *    would add a row the operator has no use for to a view whose whole problem
 *    (mt#2569) is already too many partial views.
 *
 * What IS taken from that mechanism is its SHAPE — actor id, claimed-at,
 * last-refreshed-at, staleness derived at read — which is what mt#4164's spec
 * asked for ("modelled on `tasks_claims_list`").
 *
 * Everything in this module is pure. The read-merge-write IO lives in the
 * command adapter beside the watermark store, sharing its lock.
 */

/** One pass's claim on one calibration log. */
export interface CalibrationClaim {
  /** Who holds it — the same actor identity the watermark store records. */
  readonly actorId: string;
  readonly claimedAt: string;
  readonly lastRefreshedAt: string;
}

/** The claim file's shape: log path → claim. At most one holder per log. */
export type CalibrationClaimStore = Record<string, CalibrationClaim>;

/** A claim plus the freshness derived at read time. */
export interface AnnotatedCalibrationClaim extends CalibrationClaim {
  readonly logPath: string;
  readonly ageMs: number;
  readonly stale: boolean;
}

/**
 * How long a claim stays fresh without a refresh.
 *
 * Grounded in observed pass duration rather than picked round
 * (`decision-defaults.mdc §Thresholds`): the sweep→ack span of real passes
 * measured on 2026-08-16 ran **4–10 minutes** wall-clock, the longest being a
 * 56-record classification with per-record judged-text reads. 30 minutes is ~3x
 * the longest observed, so a live pass cannot age out mid-classification while a
 * genuinely dead one frees its log within one review cadence.
 *
 * Two data points is a thin basis and the figure should be re-derived once the
 * claim itself makes pass duration measurable — which it does, since a released
 * claim records how long it was held. Deliberately NOT tuned below that: a
 * threshold shorter than a real pass reintroduces the collision it prevents,
 * which is the expensive direction of the error.
 */
export const CLAIM_STALE_MS = 30 * 60 * 1000;

export function annotateClaim(
  logPath: string,
  claim: CalibrationClaim,
  nowMs: number,
  staleMs: number = CLAIM_STALE_MS
): AnnotatedCalibrationClaim {
  const refreshed = Date.parse(claim.lastRefreshedAt);
  // An unparseable timestamp is treated as INFINITELY old rather than fresh:
  // failing toward "someone else may hold this" would deadlock every later pass
  // on one corrupt record, and the cost of the other direction is one duplicated
  // classification that `driftedPaths` still catches.
  const ageMs = Number.isNaN(refreshed) ? Number.POSITIVE_INFINITY : nowMs - refreshed;
  return { ...claim, logPath, ageMs, stale: ageMs >= staleMs };
}

/**
 * Claims held by SOMEONE ELSE and still fresh, among the paths this pass wants.
 *
 * A pass's own claim never blocks it — re-running a sweep mid-pass is normal and
 * must not lock the runner out of its own work.
 *
 * `actorId` is nullable (mt#4408): a pass whose identity could not be resolved
 * still needs to SEE other passes' claims even though it may not write one.
 * `null` excludes nothing, which is the correct reading rather than a
 * degradation — such a pass holds no claims, so it has no self to exclude.
 * Same convention, and same rationale, as `callerActorId` in
 * `packages/domain/src/session/task-claim-liveness.ts`.
 */
export function blockingClaims(
  store: CalibrationClaimStore,
  paths: readonly string[],
  actorId: string | null,
  nowMs: number,
  staleMs: number = CLAIM_STALE_MS
): AnnotatedCalibrationClaim[] {
  const blocking: AnnotatedCalibrationClaim[] = [];
  for (const path of paths) {
    const claim = store[path];
    if (!claim || claim.actorId === actorId) continue;
    const annotated = annotateClaim(path, claim, nowMs, staleMs);
    if (!annotated.stale) blocking.push(annotated);
  }
  return blocking;
}

/**
 * Take or refresh this actor's claim on each path.
 *
 * Refresh-not-duplicate, matching `presence_claims`'
 * `UNIQUE(subject_kind, subject_id, actor_id)` semantics: re-claiming preserves
 * the original `claimedAt` so a long pass's true duration stays readable, and
 * only moves `lastRefreshedAt`. A path held by a STALE other actor is taken
 * over, and the takeover is visible because `claimedAt` resets to now.
 */
export function withClaims(
  store: CalibrationClaimStore,
  paths: readonly string[],
  actorId: string,
  nowIso: string
): CalibrationClaimStore {
  const next: CalibrationClaimStore = { ...store };
  for (const path of paths) {
    const existing = next[path];
    const mine = existing?.actorId === actorId;
    next[path] = {
      actorId,
      claimedAt: mine && existing ? existing.claimedAt : nowIso,
      lastRefreshedAt: nowIso,
    };
  }
  return next;
}

/**
 * Drop this actor's claims on the given paths.
 *
 * Only its OWN — releasing another actor's claim would let a losing pass unlock
 * the winner mid-work. A path this actor does not hold is left untouched rather
 * than treated as an error: release runs at ack, and an ack whose claim already
 * aged out is a normal (if slow) pass, not a fault.
 */
export function releaseClaims(
  store: CalibrationClaimStore,
  paths: readonly string[],
  actorId: string
): CalibrationClaimStore {
  const next: CalibrationClaimStore = { ...store };
  for (const path of paths) {
    if (next[path]?.actorId === actorId) delete next[path];
  }
  return next;
}

/**
 * Drop every claim that has aged out, whoever holds it.
 *
 * Housekeeping so the file cannot grow without bound from passes that died: a
 * stale claim is already ignored by {@link blockingClaims}, so this changes no
 * decision — it only keeps the file readable.
 */
export function pruneStaleClaims(
  store: CalibrationClaimStore,
  nowMs: number,
  staleMs: number = CLAIM_STALE_MS
): CalibrationClaimStore {
  const next: CalibrationClaimStore = {};
  for (const [path, claim] of Object.entries(store)) {
    if (!annotateClaim(path, claim, nowMs, staleMs).stale) next[path] = claim;
  }
  return next;
}

/**
 * Which logs THIS pass should act on, given who else is working.
 *
 * The `isAck` branch is the whole point (PR #3015 R1). A claim answers "who is
 * WORKING"; the receipt answers "what was READ". An ack is the second question,
 * so filtering it by claims would let a pass that genuinely classified a log be
 * unable to RECORD that — because someone else started working on it in the
 * interim — silently discarding real review work. The receipt already bounds
 * what an ack may advance; the claim adds nothing there and only takes away.
 *
 * Generic over the entry shape so the caller's `ReviewDueLog` type does not have
 * to reach into this module.
 */
export function logsToActOn<T>(
  reviewDueAll: readonly T[],
  claimedByOthers: readonly string[],
  isAck: boolean,
  pathOf: (entry: T) => string
): T[] {
  if (isAck || claimedByOthers.length === 0) return [...reviewDueAll];
  return reviewDueAll.filter((entry) => !claimedByOthers.includes(pathOf(entry)));
}

/** One line per blocking claim, for the pass that has to stand down. */
export function describeBlockingClaims(claims: readonly AnnotatedCalibrationClaim[]): string[] {
  return claims.map(
    (c) =>
      `${c.logPath} — claimed by ${c.actorId} ${Math.round(c.ageMs / 1000)}s ago; ` +
      `stand down on this log (its pass owns the classification)`
  );
}
