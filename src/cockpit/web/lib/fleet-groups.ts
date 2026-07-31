/**
 * Needs-me banding + subagent-elapsed helpers for the fleet table (mt#2884).
 *
 * The Claude Code Agent View precedent (mt#2880 research): a fleet surface
 * sorts by WHAT REQUIRES THE HUMAN, never recency — needs-input and
 * ready-for-review bubble above working/idle/done, and "is it alive"
 * (liveness) stays a SEPARATE visual channel from "does it need me" (band).
 *
 * The needs-me signal is a render-side join: open asks carry
 * `parentSessionId`, so a row needs input exactly when an open ask is bound
 * to its workspace session. No new backend endpoint (mt#2884 plan decision 2).
 */

export type NeedsMeBand = "needs-input" | "review" | "working" | "idle" | "done";

/** Lower rank renders first. */
export const BAND_RANK: Record<NeedsMeBand, number> = {
  "needs-input": 0,
  review: 1,
  working: 2,
  idle: 3,
  done: 4,
};

/** The row fields banding reads — structural subset of AgentRow. */
export interface BandableRow {
  sessionId: string;
  liveness: "healthy" | "idle" | "stale" | "orphaned" | null;
  prNumber: number | null;
  prStatus: string | null;
  lastActivityAt: string;
}

/**
 * A non-terminal PR only counts as "review" when the lane showed activity
 * within this window — the live audit surfaced 70–87-day-old dead sessions
 * with fossil open/draft PRs topping the needs-me order, which is the same
 * false-alarm class as the home fleet strip's 217 stale husks. 7 days matches
 * the repo's recent-merge attention window (/plan-task gate (g)); a fossil
 * lane's PR is backlog inventory, not a supervision signal.
 */
export const REVIEW_RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** PR states that still need the loop driven (anything not terminal). */
function prNeedsAttention(prStatus: string | null): boolean {
  if (!prStatus) return false;
  const terminal = prStatus === "merged" || prStatus === "closed";
  return !terminal;
}

export function needsMeBand(
  row: BandableRow,
  askSessionIds: ReadonlySet<string>,
  now: number = Date.now()
): NeedsMeBand {
  if (askSessionIds.has(row.sessionId)) return "needs-input";
  const last = new Date(row.lastActivityAt).getTime();
  const recent = Number.isFinite(last) && now - last <= REVIEW_RECENCY_WINDOW_MS;
  if (row.prNumber != null && prNeedsAttention(row.prStatus) && recent) return "review";
  if (row.liveness === "healthy") return "working";
  if (row.liveness === "idle" || row.liveness === "stale") return "idle";
  return "done";
}

/**
 * Compact elapsed/duration string for a subagent node (mt#2884, subsumes
 * mt#2041): running nodes show time-since-start against `now`; ended nodes
 * show total runtime. Sub-minute runs render as seconds.
 */
export function subagentElapsed(
  startedAt: string | null,
  endedAt: string | null,
  now: number = Date.now()
): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const end = endedAt ? new Date(endedAt).getTime() : now;
  if (!Number.isFinite(end) || end < start) return null;
  const totalSec = Math.floor((end - start) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  return `${hours}h ${totalMin % 60}m`;
}
