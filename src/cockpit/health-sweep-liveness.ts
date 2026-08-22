/**
 * The sweep-liveness summary `/api/health` projects (mt#4384).
 *
 * **The gap this closes, stated precisely.** `/api/health` embeds the three per-sweep
 * DOMAIN trackers (`prodStateSweep`, `transcriptSweep`, `dispatchWatchdogSweep`) and
 * has never read the sweep-liveness registry at all. Abandonment lives ONLY in that
 * registry, so a wedged sweep could not appear on `/api/health` **by construction** —
 * not because a field was wrong, but because the surface never looked at the layer
 * that knows.
 *
 * Measured during the 2026-08-21 incident: `/api/sweeps` correctly showed
 * `lastErrorAt` and `abandonedTicksOutstanding: 1` for nine of eighteen sweeps, while
 * `/api/health`'s `prodStateSweep` read `lastSuccessAt: null, lastErrorAt: null,
 * consecutiveFailures: 0` — indistinguishable from "in flight, fine". That reading is
 * what cost the investigation its first hour, and `/api/health` is the surface hooks
 * and agents actually read.
 *
 * **Why the per-sweep trackers could not have carried this.** A domain tracker records
 * the OUTCOME of work. An abandoned tick never completes, so it produces no outcome,
 * ever — the tracker is not wrong, it is being asked a question it structurally cannot
 * answer (mem#862's shape: an instrument inside the call that never happens).
 *
 * **This is not residue mt#3684 left, and not a deliberate carve-out.** mt#3684's
 * criterion was *"neither surface can show a clean state while ticks are FAILING"*, and
 * it drove three consecutive FAILING ticks to prove it. An abandoned tick is not a
 * failing tick: it never settles. mt#3684 merged 2026-08-09; mt#4335 introduced the
 * abandoned-tick state on 2026-08-19, ten days later. mt#3684 delivered exactly what it
 * promised for the failure mode that existed when it shipped, and its criteria are
 * silent on a state that did not yet exist.
 *
 * @see docs/architecture/adr-035-failed-initializer-must-not-be-memoized-as-a-value.md
 * @see contract/cockpit-health-shape.json
 */

import type { SweepLivenessSnapshot } from "./sweepers";

/**
 * How many sweep names to list before truncating.
 *
 * `/api/health` is the most-polled endpoint in the system — every 5s by the tray
 * supervisor, 3x/15s by the webview — so an unbounded array here is multiplied by ~12
 * requests a minute forever. That is not hypothetical: `transcriptWatcher.activeSessions`
 * reached 1,380 entries / 209 KB per response before it was bounded, and the same comment
 * in `routes/health.ts` records it.
 *
 * The registry currently holds 17 registrants, so this cap is above the whole population
 * and truncation is not expected to fire. It exists so that a future registrant explosion
 * cannot silently turn the most-polled endpoint into a payload problem — and
 * `abandonedSweepsTruncated` says so rather than the list quietly ending.
 */
export const MAX_LISTED_ABANDONED_SWEEPS = 12;

/** The `sweepLiveness` sub-object of `GET /api/health` (mt#4384). */
export interface HealthSweepLiveness {
  /**
   * When this summary was computed.
   *
   * `health-liveness-invariant.ts` names `lastAttemptAt` as the canonical spelling for
   * a NEW dating field, and explicitly carves out the case where a field "means
   * something genuinely different". This is that case, and PR #3240 R1 caught it:
   * nothing here ATTEMPTS anything. The registry is read synchronously per request, so
   * this dates the READ — which is precisely what the sibling `dbCheck.checkedAt`
   * already means on this same payload. Reusing that spelling keeps one idea to one
   * word instead of adding a third.
   *
   * The invariant accepts any `*At` field by design, so this satisfies it.
   */
  checkedAt: string;
  /** Total sweeps registered in the liveness registry. */
  registrants: number;
  /**
   * Abandoned ticks currently outstanding across all sweeps — a tick that overran
   * `tickTimeoutMs` and whose guard is still held (mt#4335).
   *
   * **This is the number `/api/health` previously could not express.** Non-zero means
   * at least one sweep is wedged right now; it is NOT the same as a failure count, and
   * a reader must not treat a zero domain-failure count beside it as reassurance.
   */
  abandonedTicksOutstanding: number;
  /** Names of the sweeps holding those abandoned ticks, bounded per the cap above. */
  abandonedSweeps: string[];
  /** True when `abandonedSweeps` was truncated — never let the list end silently. */
  abandonedSweepsTruncated: boolean;
  /**
   * Registrants OBLIGED to state a domain outcome. As of mt#4412 both registration
   * paths oblige theirs, so this equals `registrants` unless a third path is added
   * without deciding.
   */
  declaringDomainOutcome: number;
  /**
   * Registrants that have ACTUALLY reported one yet — a runtime observation, not a
   * defect when low. It starts false for every registrant and flips on the first tick
   * that completes and returns, so shortly after a restart this legitimately trails
   * `declaringDomainOutcome`, and a sweep whose tick never settles never flips it at
   * all. Read it beside `abandonedTicksOutstanding`, never alone.
   */
  reportingDomainOutcome: number;
  /**
   * Where the per-sweep detail lives. `/api/health` deliberately carries the AGGREGATE
   * only — the full per-sweep record stays on the endpoint built for it, and this field
   * makes that pointer part of the payload rather than folklore.
   */
  authoritativeSurface: "/api/sweeps";
}

/**
 * Derive the `/api/health` sweep-liveness summary from a registry snapshot.
 *
 * Pure: takes the snapshot and the clock, returns the payload. Kept out of the route so
 * the behaviour can be asserted directly rather than through an HTTP harness, and so no
 * test needs to patch a collaborator the route reaches itself
 * (`testing-standards.mdc §Testable Design`).
 */
export function deriveHealthSweepLiveness(
  snapshot: readonly SweepLivenessSnapshot[],
  nowIso: string
): HealthSweepLiveness {
  const abandoned = snapshot.filter((s) => s.abandonedTicksOutstanding > 0);
  const abandonedNames = abandoned.map((s) => s.name).sort();

  return {
    checkedAt: nowIso,
    registrants: snapshot.length,
    abandonedTicksOutstanding: snapshot.reduce((n, s) => n + s.abandonedTicksOutstanding, 0),
    abandonedSweeps: abandonedNames.slice(0, MAX_LISTED_ABANDONED_SWEEPS),
    abandonedSweepsTruncated: abandonedNames.length > MAX_LISTED_ABANDONED_SWEEPS,
    declaringDomainOutcome: snapshot.filter((s) => s.declaresDomainOutcome).length,
    reportingDomainOutcome: snapshot.filter((s) => s.reportsDomainOutcome).length,
    authoritativeSurface: "/api/sweeps",
  };
}
