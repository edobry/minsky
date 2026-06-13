/**
 * Ask advancement (mt#2265)
 *
 * Walks `detected` Asks forward through the lifecycle. Before this module,
 * nothing in production advanced a `detected` row: `createAsk` computed
 * routing in memory and dropped the result for async transports, emission
 * callsites wrote `detected` rows directly, and the only running loop
 * (reviewer asks-reconcile-scheduler) covered `quality.review` only. The
 * result was a write-only graveyard (3,195 rows stuck in `detected` at
 * fix time).
 *
 * Two consumers:
 *   - `createAsk` (src/adapters/shared/commands/asks.ts) persists its own
 *     route result at create time via `persistRouteOutcomeForResult`.
 *   - The advancement sweep (`runAskAdvancementSweep`) runs periodically in
 *     the cockpit daemon, advancing rows the create path missed: emission-
 *     callsite rows, rows written by crashed processes, and the historical
 *     backlog (via the staleness guard).
 *
 * Per-kind delivery coverage after this module:
 *   - operator-bound transports (inbox, elicitation fallback) → `suspended`,
 *     visible on the cockpit /asks surface, respondable via respondAndClose.
 *   - policy-covered asks → `closed` with the policy citation as response.
 *   - subagent / mesh / retriever transports → `routed` with the target
 *     persisted; NO delivery loop exists for these yet (owned by mt#1570 /
 *     mt#1408 / mt#1410 / mt#1411). They are visible in count-by-state.
 *   - stale `detected` rows (older than `maxAgeMs`) → `expired`. These are
 *     ephemeral authorization/review requests whose moment has passed;
 *     routing them weeks later would flood the operator surface with dead
 *     questions.
 */

import { log } from "@minsky/shared/logger";
import type { Ask } from "./types";
import type { AskRepository, RouteOutcomeWrite } from "./repository";
import { ConcurrentTransitionError } from "./repository";
import { policyFirstRoute, type PolicyFirstRouteOptions, type RouterResult } from "./router";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default staleness cutoff: `detected` asks older than this are expired
 * rather than routed. 7 days — calibrated to Minsky's loop cadence
 * (CLAUDE.md §Thresholds: 5-day budget windows; an authorization request
 * a week old is unambiguously abandoned).
 */
export const DEFAULT_MAX_DETECTED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default per-sweep batch cap — bounds a single sweep's DB/policy work. */
export const DEFAULT_SWEEP_BATCH_LIMIT = 500;

/** Default sweep interval for the cockpit daemon loop. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Outcome shapes
// ---------------------------------------------------------------------------

export type AdvanceOutcomeKind =
  | "closed-by-policy"
  | "suspended-for-operator"
  | "suspended-for-window"
  | "routed-awaiting-transport"
  | "expired-stale"
  | "skipped"
  | "error";

export interface AdvanceOutcome {
  askId: string;
  kind: AdvanceOutcomeKind;
  detail?: string;
}

export interface SweepSummary {
  scanned: number;
  byOutcome: Record<AdvanceOutcomeKind, number>;
  errors: Array<{ askId: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Route-result → persistence mapping
// ---------------------------------------------------------------------------

/**
 * Map a router result to the `RouteOutcomeWrite` that persists it.
 *
 * Exported so `createAsk` and the sweep share ONE mapping — the route
 * result's persisted shape must not drift between the two entry points.
 */
export function routeResultToOutcomeWrite(result: RouterResult): {
  write: RouteOutcomeWrite;
  kind: AdvanceOutcomeKind;
} {
  if (result.state === "closed") {
    // Policy-covered: the router resolved the Ask itself.
    return {
      write: {
        state: "closed",
        routingTarget: result.routingTarget ?? "policy",
        response: result.response,
      },
      kind: "closed-by-policy",
    };
  }

  if (result.state === "suspended") {
    // Window-deferred: the reaper (mt#1490) dispatches when the window opens.
    return {
      write: { state: "suspended", routingTarget: result.routingTarget },
      kind: "suspended-for-window",
    };
  }

  // state === "routed" — branch on transport.
  const transportKind = result.transport.kind;
  if (transportKind === "inbox" || transportKind === "elicitation") {
    // Operator-bound. "Dispatch" for the inbox transport IS landing on the
    // operator surface; suspended = waiting for the operator's response.
    // (The elicitation case here is the no-active-server fallback — a live
    // elicitation dispatch is handled synchronously by createAsk before
    // this mapping is consulted.)
    return {
      write: { state: "suspended", routingTarget: result.routingTarget ?? "operator" },
      kind: "suspended-for-operator",
    };
  }

  // subagent / mesh / retriever: no delivery loop exists yet (mt#1570 family).
  // Persist the routing decision so the row is observably routed-not-delivered.
  return {
    write: { state: "routed", routingTarget: result.routingTarget },
    kind: "routed-awaiting-transport",
  };
}

// ---------------------------------------------------------------------------
// Single-ask advancement
// ---------------------------------------------------------------------------

export interface AdvanceOptions {
  /** Staleness cutoff; `detected` rows older than this are expired. */
  maxAgeMs?: number;
  /** Clock override for tests. */
  nowMs?: number;
}

/**
 * Advance one `detected` Ask: expire it when stale, otherwise route it and
 * persist the outcome atomically.
 *
 * Concurrency-safe: `persistRouteOutcome` only writes rows still in
 * `detected`; a concurrent advancement surfaces as `skipped`, not an error.
 */
export async function advanceDetectedAsk(
  repo: AskRepository,
  ask: Ask,
  routerOptions: PolicyFirstRouteOptions = {},
  options: AdvanceOptions = {}
): Promise<AdvanceOutcome> {
  if (ask.state !== "detected") {
    return { askId: ask.id, kind: "skipped", detail: `state=${ask.state}` };
  }

  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_DETECTED_AGE_MS;

  try {
    const ageMs = nowMs - new Date(ask.createdAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
      await repo.persistRouteOutcome(ask.id, { state: "expired" });
      return { askId: ask.id, kind: "expired-stale", detail: `ageMs=${Math.round(ageMs)}` };
    }

    const result = await policyFirstRoute(ask, { ...routerOptions, nowMs });
    const { write, kind } = routeResultToOutcomeWrite(result);
    await repo.persistRouteOutcome(ask.id, write);
    return { askId: ask.id, kind };
  } catch (err) {
    if (err instanceof ConcurrentTransitionError) {
      // Another actor advanced this row first — fine, not an error.
      return { askId: ask.id, kind: "skipped", detail: "concurrent-advancement" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { askId: ask.id, kind: "error", detail: message };
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface SweepOptions extends AdvanceOptions {
  /** Max rows advanced per sweep (oldest first). */
  batchLimit?: number;
}

/**
 * One advancement pass over all `detected` Asks (oldest first, capped at
 * `batchLimit`). Errors on individual asks are collected, never thrown —
 * the sweep is a recovery loop and must not crash its host process.
 */
export async function runAskAdvancementSweep(
  repo: AskRepository,
  routerOptions: PolicyFirstRouteOptions = {},
  options: SweepOptions = {}
): Promise<SweepSummary> {
  const batchLimit = options.batchLimit ?? DEFAULT_SWEEP_BATCH_LIMIT;

  const byOutcome: Record<AdvanceOutcomeKind, number> = {
    "closed-by-policy": 0,
    "suspended-for-operator": 0,
    "suspended-for-window": 0,
    "routed-awaiting-transport": 0,
    "expired-stale": 0,
    skipped: 0,
    error: 0,
  };
  const errors: Array<{ askId: string; message: string }> = [];

  let detected: Ask[];
  try {
    detected = await repo.listByState("detected");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("ask.advancement: sweep could not list detected asks", { message });
    return { scanned: 0, byOutcome, errors: [{ askId: "(list)", message }] };
  }

  detected.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const batch = detected.slice(0, batchLimit);

  for (const ask of batch) {
    const outcome = await advanceDetectedAsk(repo, ask, routerOptions, options);
    byOutcome[outcome.kind] += 1;
    if (outcome.kind === "error") {
      errors.push({ askId: outcome.askId, message: outcome.detail ?? "unknown" });
    }
  }

  const summary: SweepSummary = { scanned: batch.length, byOutcome, errors };
  if (batch.length > 0) {
    log.info("ask.advancement: sweep complete", {
      scanned: summary.scanned,
      remaining: detected.length - batch.length,
      ...byOutcome,
      errorCount: errors.length,
    });
  }
  return summary;
}
