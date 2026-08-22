/**
 * Ask state-counts provider (mt#2265 observability).
 *
 * Module-level registry that `debug.systemInfo` reads to surface asks
 * count-by-state. Wired by the MCP start-command once a DB connection is
 * resolved (same pattern as `SubagentDispatchTracker.setInstance`, mt#1738);
 * unwired contexts (CLI without Postgres, early boot) get a zero-filled
 * `available: false` snapshot — the call never throws.
 *
 * Why this exists: 3,195 asks sat stuck in `detected` for 5+ weeks and were
 * only discovered by a manual DB probe (mt#2257). With count-by-state on
 * `debug_systemInfo`, a stuck pipeline is visible on the surface operators
 * already read.
 *
 * mt#2568: the one-shot `setAskStateCountsRepository()` fast-path (called
 * fire-and-forget from the MCP start-command once) has no retry of its own.
 * If it hasn't completed — or fails outright — by the time
 * `getAskStateCounts()` is first called (e.g. a proxy/staleness-respawned
 * server, the exact race mt#2562/mt#2567 diagnosed for the presence
 * write-path), the provider stays permanently unavailable for the life of
 * the process, silently defeating the stuck-pipeline detector right when a
 * deploy-restart timing window makes it most likely to matter.
 * `registerAskStateCountsBuilder` gives `getAskStateCounts()` a per-call
 * fallback that builds a fresh repository on demand — mirrors the
 * `buildAskRepository` / `MinskyMCPServer.getPresenceClaimRepo` per-call
 * fallback pattern from mt#2567 — so every call is correct regardless of
 * startup-wiring timing.
 */

import { log } from "@minsky/shared/logger";
import { ALL_ASK_STATES } from "./state-machine";
import type { OpenAskState } from "./state-machine";
import type { AskState } from "./types";
import { emptyOpenStateAgeStats } from "./repository";
import type { AskRepository, AskAgeStats } from "./repository";

/**
 * Dwell time past which an open ask is reported as stalled (mt#4361).
 *
 * 5 days, from `decision-defaults.mdc §Thresholds` ("Stall threshold (status
 * hasn't changed): 5 days for active work") — the same observed-cadence figure
 * the task graph uses, not a round number picked here. Deliberately SHORTER
 * than the 7-day TTLs in `advancement.ts` and `stale-suspended-close.ts`: those
 * decide when to RETIRE an ask and want to be conservative, this only decides
 * when to SHOW one, so it should fire first.
 */
export const DEFAULT_ASK_STALL_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000;

export interface AskStateCountsSnapshot {
  /** False when no repository is wired or the count query failed. */
  available: boolean;
  total: number;
  byState: Record<AskState, number>;
  /**
   * The threshold `ageByState[*].stalledCount` was computed against (mt#4361).
   *
   * Reported alongside the counts because a bare "3 stalled" is not a finding
   * until the reader knows "older than what" — and the threshold is a tunable,
   * so a consumer must not assume it.
   */
  stallThresholdMs: number;
  /**
   * Per OPEN state: how long the oldest ask has been sitting there, and how
   * many are past `stallThresholdMs` (mt#4361).
   *
   * `byState` above counts; this is the dimension that separates a `routed`
   * ask waiting 30 seconds for its transport from one no transport will ever
   * come for. Terminal states are absent by construction — see
   * `OPEN_ASK_STATES`.
   */
  ageByState: Record<OpenAskState, AskAgeStats>;
}

/** Per-call fallback builder registered by the MCP start-command (mt#2568). */
export type AskStateCountsRepoBuilder = () => Promise<AskRepository | null>;

let wiredRepo: AskRepository | null = null;
let repoBuilder: AskStateCountsRepoBuilder | null = null;

/** Wire the repository used for count-by-state reads (MCP start-command). */
export function setAskStateCountsRepository(repo: AskRepository): void {
  wiredRepo = repo;
}

/**
 * Register the per-call fallback builder `getAskStateCounts()` invokes
 * whenever the one-shot `setAskStateCountsRepository()` fast-path hasn't
 * fired yet (mt#2568). Called once by the MCP server's startup path. Pass
 * `null` to clear the registration.
 */
export function registerAskStateCountsBuilder(builder: AskStateCountsRepoBuilder | null): void {
  repoBuilder = builder;
}

/** Test seam: unwire the repository. */
export function resetAskStateCountsRepository(): void {
  wiredRepo = null;
  repoBuilder = null;
}

function zeroFilled(): Record<AskState, number> {
  return Object.fromEntries(ALL_ASK_STATES.map((s) => [s, 0])) as Record<AskState, number>;
}

/**
 * The snapshot returned whenever no repository could be reached or the query
 * failed — one builder, so every unavailable path returns the same shape.
 *
 * Note what `available: false` is doing here: this module's counter lives
 * INSIDE the query it reports on, so it is structurally blind to anything that
 * prevents that query from running (mem#862 — a health instrument inside the
 * call that never happens). The flag is the honest reading of that blindness;
 * a consumer must branch on it rather than read the zeros as data.
 */
function unavailableSnapshot(): AskStateCountsSnapshot {
  return {
    available: false,
    total: 0,
    byState: zeroFilled(),
    stallThresholdMs: DEFAULT_ASK_STALL_THRESHOLD_MS,
    ageByState: emptyOpenStateAgeStats(),
  };
}

/**
 * Resolve the repository to use for this call: the pre-set fast-path repo
 * if wiring already completed, otherwise a fresh per-call build via the
 * registered fallback builder (mt#2568). Never throws.
 */
async function resolveRepo(): Promise<AskRepository | null> {
  if (wiredRepo) return wiredRepo;
  if (!repoBuilder) return null;
  try {
    return await repoBuilder();
  } catch (err) {
    log.debug("ask.state-counts: per-call repo build failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Snapshot asks count-by-state. Fail-safe: never throws. */
export async function getAskStateCounts(): Promise<AskStateCountsSnapshot> {
  const repo = await resolveRepo();
  if (!repo) {
    return unavailableSnapshot();
  }
  try {
    // One clock for both reads, so the ages cannot be measured against a
    // different instant than the counts they sit beside.
    const nowMs = Date.now();
    const [byState, ageByState] = await Promise.all([
      repo.countByState(),
      repo.openStateAgeStats({
        nowMs,
        stallThresholdMs: DEFAULT_ASK_STALL_THRESHOLD_MS,
      }),
    ]);
    const total = Object.values(byState).reduce((sum, n) => sum + n, 0);
    return {
      available: true,
      total,
      byState,
      stallThresholdMs: DEFAULT_ASK_STALL_THRESHOLD_MS,
      ageByState,
    };
  } catch (err) {
    log.warn("ask.state-counts: count query failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return unavailableSnapshot();
  }
}
