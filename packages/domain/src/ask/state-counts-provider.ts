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
 */

import { log } from "@minsky/shared/logger";
import { ALL_ASK_STATES } from "./state-machine";
import type { AskState } from "./types";
import type { AskRepository } from "./repository";

export interface AskStateCountsSnapshot {
  /** False when no repository is wired or the count query failed. */
  available: boolean;
  total: number;
  byState: Record<AskState, number>;
}

let wiredRepo: AskRepository | null = null;

/** Wire the repository used for count-by-state reads (MCP start-command). */
export function setAskStateCountsRepository(repo: AskRepository): void {
  wiredRepo = repo;
}

/** Test seam: unwire the repository. */
export function resetAskStateCountsRepository(): void {
  wiredRepo = null;
}

function zeroFilled(): Record<AskState, number> {
  return Object.fromEntries(ALL_ASK_STATES.map((s) => [s, 0])) as Record<AskState, number>;
}

/** Snapshot asks count-by-state. Fail-safe: never throws. */
export async function getAskStateCounts(): Promise<AskStateCountsSnapshot> {
  if (!wiredRepo) {
    return { available: false, total: 0, byState: zeroFilled() };
  }
  try {
    const byState = await wiredRepo.countByState();
    const total = Object.values(byState).reduce((sum, n) => sum + n, 0);
    return { available: true, total, byState };
  } catch (err) {
    log.warn("ask.state-counts: count query failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { available: false, total: 0, byState: zeroFilled() };
  }
}
