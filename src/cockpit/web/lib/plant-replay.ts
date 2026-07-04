/**
 * Plant-board time-scrubber replay engine (mt#2600, v3 feature 1 of mt#2378).
 *
 * Pure logic for "drag a time window over the accumulated system_events
 * history and replay it": window selection from a scrub input, chronological
 * ordering of the fetched window, and playback pacing. NO React, NO DOM, NO
 * timers — PlantFlowPage.tsx owns the ticking clock and feeds elapsed time
 * in via `dueSteps`; everything here is a plain function of its inputs, so
 * it is unit-testable without fake timers.
 *
 * Replay drives motion through the SAME gesture dictionary as live mode
 * (`plant-gestures.ts`'s `mapEventToGestures`) — PlantFlowPage.tsx's shared
 * `fireGestures` callback is called by both the live-poll effect and the
 * replay stepper. No replay-only vocabulary exists here (honest-motion law,
 * mt#2375): this module never invents a gesture — it only sequences and
 * paces gestures the dictionary would already produce for these rows.
 *
 * Re-baselining on exit (the "no catch-up gestures" acceptance test) is NOT
 * implemented in this module — it falls out of reusing `plant-gestures.ts`'s
 * existing `createGestureEngineState()` / `takeNewEvents()` baseline
 * mechanics: PlantFlowPage.tsx replaces the live engine's state with a fresh
 * one and forces a live re-poll on exit, and the existing "first poll only
 * baselines" rule (unchanged by this task) does the rest.
 */
import type { SystemEventRow } from "../hooks/useSystemEvents";

// ---------------------------------------------------------------------------
// Mode + window types
// ---------------------------------------------------------------------------

/** Whether the board is animating from the live poller or a replayed window. */
export type PlantMode = "live" | "replay";

export interface ReplayWindow {
  /** ISO-8601 inclusive lower bound. */
  since: string;
  /** ISO-8601 inclusive upper bound. */
  until: string;
}

// ---------------------------------------------------------------------------
// Speed + pacing constants
// ---------------------------------------------------------------------------

/** Available playback speed multipliers (design sketch: 1x/10x/60x). */
export const REPLAY_SPEEDS = [1, 10, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export const DEFAULT_REPLAY_SPEED: ReplaySpeed = 10;

/**
 * Per-step delay bounds (ms), regardless of the real gap between two events'
 * `createdAt` timestamps once scaled by speed. `MIN_STEP_MS` keeps a dense
 * burst of events from being visually indistinguishable as separate
 * gestures; `MAX_STEP_MS` keeps a quiet stretch in the source history from
 * stalling playback for real-world minutes. This is "faithful relative
 * timing" (the task spec's stated preference) clamped to a usable range —
 * not the alternative "stepped pacing" (fixed interval per event regardless
 * of real gaps), which the spec allows but this implementation improves on.
 */
export const MIN_STEP_MS = 300;
export const MAX_STEP_MS = 4_000;

// ---------------------------------------------------------------------------
// Window selection
// ---------------------------------------------------------------------------

/** Window-span presets offered by the scrubber's duration control. */
export const REPLAY_SPAN_PRESETS_MS = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
} as const;
export type ReplaySpanPreset = keyof typeof REPLAY_SPAN_PRESETS_MS;
export const DEFAULT_REPLAY_SPAN: ReplaySpanPreset = "15m";

/**
 * Compute an ISO `{ since, until }` window from a "look back `lookbackMs`,
 * span `spanMs`" scrub position. `lookbackMs` is how far before `nowMs` the
 * window's END sits (0 = the window ends now); `spanMs` is the window's
 * width. Both are clamped to non-negative / non-zero values so a malformed
 * UI input can't produce an inverted or zero-width window.
 */
export function computeReplayWindow(
  nowMs: number,
  lookbackMs: number,
  spanMs: number
): ReplayWindow {
  const untilMs = nowMs - Math.max(0, lookbackMs);
  const sinceMs = untilMs - Math.max(1, spanMs);
  return { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() };
}

/**
 * True when `since` is strictly before `until` — the only valid window
 * shape. Shared by BOTH the UI (ScrubberBar's enter-replay enable/disable
 * gate) and the fetch hook (`useReplayEvents`'s `enabled` condition) as
 * defense-in-depth, so an inverted range can never reach the server even if
 * a future caller constructs a `ReplayWindow` without going through the
 * scrubber form (mt#2600 R1 review).
 */
export function isValidReplayWindow(window: ReplayWindow): boolean {
  return Date.parse(window.since) < Date.parse(window.until);
}

// ---------------------------------------------------------------------------
// Ordering + pacing (the replay "schedule")
// ---------------------------------------------------------------------------

export interface ReplayStep {
  event: SystemEventRow;
  /** Cumulative ms from playback start (t=0) until this step should fire. */
  offsetMs: number;
}

/**
 * Order the fetched window's events oldest-first (`/api/activity` returns
 * most-recent-first — see `listEvents`'s `ORDER BY created_at DESC`) and
 * assign each a cumulative playback offset, scaled by `speed` and clamped to
 * `[MIN_STEP_MS, MAX_STEP_MS]` per step. The first event always fires at
 * offset 0 (playback start).
 */
export function buildReplaySchedule(events: SystemEventRow[], speed: ReplaySpeed): ReplayStep[] {
  const ordered = [...events].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let cumulative = 0;
  return ordered.map((event, i) => {
    if (i === 0) {
      return { event, offsetMs: 0 };
    }
    const prev = ordered[i - 1] as SystemEventRow;
    const realGapMs = Math.max(0, Date.parse(event.createdAt) - Date.parse(prev.createdAt));
    const stepMs = Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, realGapMs / speed));
    cumulative += stepMs;
    return { event, offsetMs: cumulative };
  });
}

// ---------------------------------------------------------------------------
// Playback stepping — pure "what's due" check, driven by the page's clock
// ---------------------------------------------------------------------------

export interface DueStepsResult {
  /** Steps whose offset has been reached since the last check, in order. */
  due: ReplayStep[];
  /** Updated count of steps fired so far — pass back in on the next tick. */
  firedCount: number;
}

/**
 * Given a schedule and how many ms of playback have elapsed, return the
 * steps newly due (`offsetMs <= elapsedMs`) since `firedCount`. Pure: the
 * caller (PlantFlowPage) owns the wall clock and calls this on every tick.
 */
export function dueSteps(
  schedule: ReplayStep[],
  elapsedMs: number,
  firedCount: number
): DueStepsResult {
  const due: ReplayStep[] = [];
  let i = firedCount;
  while (i < schedule.length && (schedule[i] as ReplayStep).offsetMs <= elapsedMs) {
    due.push(schedule[i] as ReplayStep);
    i++;
  }
  return { due, firedCount: i };
}

/** True once every step in a non-empty schedule has fired. */
export function isReplayComplete(schedule: ReplayStep[], firedCount: number): boolean {
  return schedule.length > 0 && firedCount >= schedule.length;
}
