/**
 * Session-film tunables (mt#3184 — Watchable world Phase 1).
 *
 * Spec SC 9: "Tunables in one config object (not architecture)": DOI
 * weights/decay/budget, animation durations/easing, contour styling, wedge
 * allocation, keyframe interval, `?t=` arrival behavior. This is the ONE
 * object every session-film module reads knobs from — no tunable constant
 * should be hand-coded anywhere else under `session-film-*`.
 *
 * @see RFC (Notion `3a7937f0-3cb4-81ae-8f78-e7a5d5415d0a`) — "Deliberately
 *   deferred to the prototype" list in the MVP section names every knob
 *   below as a Phase-1-gate-session tuning target, not an architectural
 *   commitment.
 */

/** Fixed compass bearings for realm trees around the agent's home (spec SC 5). Angles in degrees, 0 = north (up), clockwise. */
export const REALM_BEARINGS_DEG = {
  repo: 315, // northwest
  "minsky-substrate": 45, // northeast
  web: 90, // east
  notion: 135, // southeast
  shell: 180, // south
  agents: 225, // west (spawned agents / workspaces)
  unknown: 270, // northwest-adjacent catch-all — kept visually distinct, low DOI weight
} as const;

export interface SessionFilmConfig {
  /** Degree-of-interest: fixed per-realm-depth a-priori importance weight (before recency/distance terms). */
  doi: {
    /** a-priori importance: entity type at depth 0 (a realm root) always scores this floor. */
    rootImportance: number;
    /** a-priori importance decays this much per additional tree depth level. */
    depthDecay: number;
    /** Recency weight: how much a touch's "distance from playhead" subtracts per batch-row of distance. */
    recencyDecayPerBatch: number;
    /** DOI threshold above which a node renders expanded. */
    expandThreshold: number;
    /** Visible-node budget across all realms combined (spec: ~60-80). */
    visibleNodeBudget: number;
  };
  /** Keyframe snapshot interval, in BATCH ROWS (not raw events) — see session-film-fold.ts. */
  keyframeIntervalBatches: number;
  /** Animation tunables (CSS/WAAPI tween durations, ms) — degrade to 0 under prefers-reduced-motion. */
  motion: {
    excursionDurationMs: number;
    beamDurationMs: number;
    idleDriftDurationMs: number;
    easing: string;
  };
  /** `?t=` arrival behavior: "snap" (instant, the spec's stated default) or "catchup" (brief replay). */
  deepLinkArrival: "snap" | "catchup";
  /** Touched-set contour (bubblesets-js) styling knobs. */
  contour: {
    strokeWidth: number;
    padding: number;
    opacity: number;
  };
}

export const DEFAULT_SESSION_FILM_CONFIG: SessionFilmConfig = {
  doi: {
    rootImportance: 0.8,
    depthDecay: 0.15,
    recencyDecayPerBatch: 0.1,
    expandThreshold: 0.35,
    visibleNodeBudget: 70,
  },
  keyframeIntervalBatches: 25,
  motion: {
    excursionDurationMs: 420,
    beamDurationMs: 260,
    idleDriftDurationMs: 600,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)", // ease-out-quint, per interface-design motion guidance
  },
  deepLinkArrival: "snap",
  contour: {
    strokeWidth: 2,
    padding: 12,
    opacity: 0.28,
  },
};
