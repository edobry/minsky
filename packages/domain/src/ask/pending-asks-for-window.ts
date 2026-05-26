/**
 * Query: pending Asks eligible for dispatch when a service window opens — mt#1490.
 *
 * This module provides `pendingAsksForWindow`, the TypeScript-layer query that
 * the Reaper uses to find Asks to dispatch on `minsky.attention_window_opened`.
 *
 * Design note: The spec describes a SQL view (`pending_asks_for_window`), but
 * Postgres views cannot accept parameters. The equivalent result is achieved via
 * a parameterized TypeScript query over the `AskRepository` interface, which
 * keeps the domain layer database-agnostic. The SQL representation is documented
 * here as a reference for the Cockpit widget (mt#1147).
 *
 * Equivalent SQL (for reference; not executed via Drizzle):
 * ```sql
 * SELECT a.*
 * FROM asks a
 * WHERE a.state IN ('routed', 'suspended')
 *   AND (
 *     (a.service_strategy = 'scheduled' AND a.window_key = $window_key)
 *     OR (a.service_strategy = 'deadline-bound'
 *         AND a.deadline <= now() + interval '15 minutes')
 *     OR (a.metadata->>'pinnedToWindow' = $window_key)
 *   )
 * ORDER BY
 *   CASE a.kind
 *     WHEN 'stuck.unblock'         THEN 1
 *     WHEN 'authorization.approve' THEN 2
 *     WHEN 'direction.decide'      THEN 3
 *     WHEN 'quality.review'        THEN 4
 *     WHEN 'coordination.notify'   THEN 5
 *     ELSE 6
 *   END,
 *   COALESCE(a.deadline, 'infinity'::timestamptz) ASC,
 *   a.created_at ASC;
 * ```
 */

import type { Ask, AskKind } from "./types";
import type { AskRepository } from "./repository";
import { PAGE_THRESHOLD_MS } from "./router";

// ---------------------------------------------------------------------------
// Kind-priority ordering (spec: stuck.unblock > authorize > decide > review > notify)
// ---------------------------------------------------------------------------

/**
 * Priority order for kind-based sort (lower number = higher priority).
 *
 * Per the spec: `stuck.unblock` > `authorization.approve` > `direction.decide`
 * > `quality.review` > `coordination.notify`.
 * All other kinds (capability.escalate, information.retrieve) are lower priority
 * in a window context — they are typically `asap` strategy and should not
 * normally appear in a suspended state.
 */
const KIND_PRIORITY: Record<AskKind, number> = {
  "stuck.unblock": 1,
  "authorization.approve": 2,
  "direction.decide": 3,
  "quality.review": 4,
  "coordination.notify": 5,
  "capability.escalate": 6,
  "information.retrieve": 7,
};

function kindPriority(kind: AskKind): number {
  return KIND_PRIORITY[kind] ?? 99;
}

// ---------------------------------------------------------------------------
// Filter predicate
// ---------------------------------------------------------------------------

/**
 * Returns true when an Ask is eligible for dispatch during the given window.
 *
 * An Ask is eligible when:
 *   1. Its state is `"routed"` or `"suspended"` (not yet dispatched or deferred).
 *   2. One of the following is true:
 *      a. `serviceStrategy === "scheduled"` AND `windowKey` matches the opening window.
 *      b. `serviceStrategy === "deadline-bound"` AND deadline is within PAGE_THRESHOLD.
 *      c. `metadata.pinnedToWindow` matches the opening window.
 *
 * @param ask        The Ask to evaluate.
 * @param windowKey  The key of the window that is opening.
 * @param nowMs      Current timestamp in milliseconds (injectable for tests).
 */
export function isEligibleForWindow(ask: Ask, windowKey: string, nowMs: number): boolean {
  // Only acts on asks that are pending dispatch.
  if (ask.state !== "routed" && ask.state !== "suspended") {
    return false;
  }

  const strategy = ask.serviceStrategy ?? "asap";

  // Condition a: scheduled for this specific window.
  if (strategy === "scheduled" && ask.windowKey === windowKey) {
    return true;
  }

  // Condition b: deadline-bound and within page-threshold.
  if (strategy === "deadline-bound") {
    const deadline = ask.deadline ? new Date(ask.deadline).getTime() : null;
    if (deadline !== null && deadline - nowMs <= PAGE_THRESHOLD_MS) {
      return true;
    }
  }

  // Condition c: pinned to this window via metadata.
  const pinned = ask.metadata?.["pinnedToWindow"];
  if (typeof pinned === "string" && pinned === windowKey) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Sort comparator
// ---------------------------------------------------------------------------

/**
 * Sort comparator for pending Asks.
 *
 * Sort order (ascending priority):
 *   1. Kind priority (stuck.unblock first, coordination.notify last).
 *   2. Deadline urgency (earliest deadline first; no-deadline last).
 *   3. Creation time (oldest first — FIFO within same priority band).
 */
export function compareAskPriority(a: Ask, b: Ask): number {
  // 1. Kind priority
  const kindDiff = kindPriority(a.kind) - kindPriority(b.kind);
  if (kindDiff !== 0) return kindDiff;

  // 2. Deadline urgency (no deadline = far future = lower urgency)
  const aDeadline = a.deadline ? new Date(a.deadline).getTime() : Infinity;
  const bDeadline = b.deadline ? new Date(b.deadline).getTime() : Infinity;
  if (aDeadline !== bDeadline) return aDeadline - bDeadline;

  // 3. FIFO: oldest created_at first
  const aCreated = new Date(a.createdAt).getTime();
  const bCreated = new Date(b.createdAt).getTime();
  return aCreated - bCreated;
}

// ---------------------------------------------------------------------------
// Main query function
// ---------------------------------------------------------------------------

/**
 * Find all pending Asks eligible for dispatch when `windowKey` opens.
 *
 * Fetches suspended and routed Asks from the repository, filters to those
 * matching this window's cohort, and returns them sorted by priority.
 *
 * This is the TypeScript equivalent of the `pending_asks_for_window` SQL view
 * described in the mt#1490 spec. It is consumed by the Reaper on every
 * `minsky.attention_window_opened` NOTIFY event.
 *
 * @param repo      Ask repository (injectable — real or fake for tests).
 * @param windowKey The key of the window that just opened.
 * @param nowMs     Current timestamp (injectable for tests; defaults to Date.now()).
 * @returns         Sorted array of eligible Asks (may be empty).
 */
export async function pendingAsksForWindow(
  repo: AskRepository,
  windowKey: string,
  nowMs: number = Date.now()
): Promise<Ask[]> {
  // Fetch all non-terminal pending asks (both "routed" and "suspended").
  // We need both because:
  //   - "suspended" is the state for window-deferred Asks (set by the router).
  //   - "routed" is included for deadline-bound asks that may have been
  //     routed but not yet dispatched (edge case after restart).
  const [routed, suspended] = await Promise.all([
    repo.listByState("routed"),
    repo.listByState("suspended"),
  ]);

  const candidates = [...routed, ...suspended];

  // Filter to eligible cohort for this window.
  const eligible = candidates.filter((ask) => isEligibleForWindow(ask, windowKey, nowMs));

  // Sort by priority (kind > deadline > createdAt).
  eligible.sort(compareAskPriority);

  return eligible;
}
