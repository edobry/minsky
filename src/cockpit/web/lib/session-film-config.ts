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
import type { EventRealm } from "@minsky/domain/transcripts/event-schema";

/**
 * Fixed compass bearings for realm trees around the agent's home (spec
 * SC 5). Angles in degrees, 0 = north (up), clockwise.
 *
 * Typed as `Record<EventRealm, number>` (NOT a bare `as const` object
 * literal) so this is COMPILE-TIME complete against the schema's realm
 * union — a future realm added to `EventRealm` without a matching bearing
 * here fails to compile, instead of silently producing `undefined` (and
 * NaN world coordinates downstream in `session-film-layout.ts`) at
 * runtime. Reviewer finding (PR #2269 round 1): the previous `as const`
 * form had no structural link to `EventRealm` at all.
 */
export const REALM_BEARINGS_DEG: Record<EventRealm, number> = {
  repo: 315, // northwest
  "minsky-substrate": 45, // northeast
  web: 90, // east
  notion: 135, // southeast
  shell: 180, // south
  agents: 225, // west (spawned agents / workspaces)
  unknown: 270, // northwest-adjacent catch-all — kept visually distinct, low DOI weight
};

/**
 * Operator-facing display label per realm (mt#3226 SC 5): the `unknown`
 * realm is an internal adapter-coverage fallback name (event-adapter.ts's
 * total-fallback path) and must never leak to the operator verbatim — the
 * 2026-07-25 screenshot showed a bare "UNKNOWN" root label. Every other
 * realm's display label is its own name (no change from today's rendering).
 */
export const REALM_DISPLAY_LABEL: Record<EventRealm, string> = {
  repo: "repo",
  "minsky-substrate": "minsky-substrate",
  web: "web",
  notion: "notion",
  shell: "shell",
  agents: "agents",
  unknown: "other",
};

/**
 * Realm color accent, expressed as the SAME `oklch(var(--token) / alpha)`
 * pattern `status-colors.ts` uses for inline-style consumers (mt#3226 SC 2).
 * Reuses the existing VSM-organ brand tokens (`docs/brand-system.md` §7)
 * rather than minting a new 7-color palette — seven realms, seven existing
 * organ tokens, no new hex anywhere in the semantic layer. The mapping is a
 * thematic fit, not an organ-identity claim: repo/execution work reads as
 * "operations" (S1), the Minsky substrate itself as "management" (S3),
 * external web research as "future-facing" (S4), Notion/docs as the
 * "learning loop", shell commands as "coordination" (S2), spawned
 * agents/workspaces as the "attention seam" (spawn boundaries ARE an
 * attention event), and the `unknown`/"other" catch-all as neutral (S5).
 */
export const REALM_COLOR_VAR: Record<EventRealm, string> = {
  repo: "--vsm-s1",
  "minsky-substrate": "--vsm-s3",
  web: "--vsm-s4",
  notion: "--vsm-learn",
  shell: "--vsm-s2",
  agents: "--vsm-seam",
  unknown: "--vsm-s5",
};

/** Resolve a realm's color accent to a CSS color string, at the given alpha. */
export function realmColorStyle(realm: EventRealm, alpha = 1): string {
  const token = REALM_COLOR_VAR[realm];
  return alpha >= 1 ? `oklch(var(${token}))` : `oklch(var(${token}) / ${alpha})`;
}

export interface SessionFilmConfig {
  /** Degree-of-interest: fixed per-realm-depth a-priori importance weight (before recency/distance terms). */
  doi: {
    /** a-priori importance: entity type at depth 0 (a realm root) always scores this floor. */
    rootImportance: number;
    /** a-priori importance decays this much per additional tree depth level. */
    depthDecay: number;
    /**
     * Recency decay RATE, per elapsed second between a touch and the
     * playhead's current wall-clock time (`exp(-rate * elapsedSeconds)`).
     * Deliberately elapsed-TIME-based rather than batch-row-distance-based:
     * `WorldFoldState`'s `EntityFoldState` tracks `lastTouchedAt` as a
     * timestamp, not a batch-row ordinal (see session-film-fold.ts) — using
     * wall-clock recency is also consistent with the RFC's "honest time
     * alongside honest motion" principle (a 40-minute-old touch and a
     * 2-second-old touch must not read as equally "fresh").
     */
    recencyDecayPerSecond: number;
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
  /**
   * Organic child layout (mt#3226 SC 5): radial-arc distribution replacing
   * the previous Cartesian perpendicular-spread, which degenerated into a
   * rigid "comb" (long straight diagonal lines) at high fanout — the
   * operator's 2026-07-25 screenshot (minsky-substrate 25 children, shell
   * 32 children).
   */
  layout: {
    /** Minimum angular span (degrees) allocated to a realm's children, before the per-leaf scaling term. */
    arcSpanBaseDeg: number;
    /** Additional angular span (degrees) per sqrt(leafCount) — sublinear so a busy realm gets more room without unbounded growth. */
    arcSpanPerLeafDeg: number;
    /**
     * Hard cap on total angular span (degrees). Kept safely under the 45deg
     * gap between adjacent fixed realm bearings (REALM_BEARINGS_DEG) so a
     * high-fanout realm's fan never visually crosses into a neighboring
     * realm's sector — the "kill the dead-space imbalance" directive cuts
     * both ways: adaptive room for busy realms, a ceiling so busy realms
     * don't collide with their neighbors.
     */
    arcSpanMaxDeg: number;
    /** Deterministic per-node angular jitter magnitude (degrees), seeded by node id — organic irregularity without randomness (stable across re-renders/replays). */
    jitterAngleDeg: number;
    /** Deterministic per-node radial jitter magnitude (world units), seeded by node id. */
    jitterRadiusPx: number;
    /** Collision-aware spacing: alternating radial stagger (world units) applied by sibling order parity, so a dense fan of same-depth siblings doesn't render as a single flat overlapping ring. */
    siblingStaggerPx: number;
  };
  /**
   * Aliveness pass (mt#3226 SC 4): bloom/glow, continuous decay brightness,
   * spring-settle arrivals, and ambient camera drift. AMBIENT-register
   * carve-out from the plant board's honest-motion law (design-decision
   * record — see SessionFilmStage.tsx's module doc comment for the full
   * text): these tunables drive PURELY DECORATIVE motion (camera drift,
   * idle float, brightness decay) that never invents an event (no fake
   * beams, no fake node touches) — event-driven motion (excursions, beams,
   * arrivals) stays strictly honest and is gated by the SAME
   * `prefers-reduced-motion` signal as every value below.
   */
  aliveness: {
    /** SVG `feGaussianBlur` stdDeviation for the bloom/glow filter (world units). */
    bloomBlurStdDeviation: number;
    /** Continuous brightness-decay rate, per elapsed second since an entity/agent's last touch (mirrors doi.recencyDecayPerSecond's shape, independent knob — see the module doc's "scene cools between events" requirement). */
    glowDecayPerSecond: number;
    /** How often the ambient brightness clock re-renders, ms (NOT an event — a pure visual re-paint of already-known recency; disabled entirely under reduced motion). */
    glowTickIntervalMs: number;
    /** Arrival spring overshoot scale (1 = no overshoot; >1 = the node grows past its final size before settling back). */
    arrivalOvershootScale: number;
    /** Arrival spring-settle duration, ms. */
    arrivalSettleMs: number;
    /** Ambient camera drift amplitude (world units) — a slow position/zoom breathing when idle. */
    driftAmplitudePx: number;
    /** Ambient camera drift period, ms (one full drift cycle). */
    driftPeriodMs: number;
    /** Avatar idle-float amplitude (world units, vertical). */
    avatarFloatAmplitudePx: number;
    /** Avatar idle-float period, ms. */
    avatarFloatPeriodMs: number;
  };
  /**
   * Living layout (mt#3231 SC 4 — the A2->A3 motion climb): tunables for the
   * live d3-force simulation replacing the v1.1 compute-once tidy-tree +
   * CSS-transition model. `homeStrength` is the "warm start stays organic,
   * not chaotic" knob — it springs every node back toward its ORIGINAL
   * tidy-tree slot (`session-film-layout.ts`'s radial-arc position), so
   * `charge`/`link` only add gentle perturbation, never a random scatter.
   * Realm ROOTS are pinned (fx/fy) regardless of these forces — see
   * `session-film-force-layout.ts`.
   */
  forceLayout: {
    /** Node-to-node repulsion strength (negative = repel; forceManyBody). */
    chargeStrength: number;
    /** Target rest length for a parent-child link (forceLink), world units. */
    linkDistance: number;
    /** Link-force strength (0-1ish; forceLink). */
    linkStrength: number;
    /** Strength (0-1) of the spring pulling a node back toward its nominal tidy-tree slot (forceX/forceY). */
    homeStrength: number;
    /** How often the live simulation ticks + re-renders, ms — NOT an event; the SAME already-real fold-driven nodes settling among themselves (honest-motion carve-out documented in session-film-force-layout.ts). */
    tickIntervalMs: number;
  };
  /**
   * Camera-follow / growing-bounding-box auto-fit (mt#3231 SC 5 — the RFC's
   * A3 "camera-follow" rung). See `PanZoomSVG.tsx`'s `GrowingBoundsOptions`.
   */
  camera: {
    /** World-space padding added around the touched-set's live bounding box before fitting. */
    paddingPx: number;
    /** Ease duration toward a new camera fit, ms. Callers pass 0 under `prefers-reduced-motion` (snap instead of tween). */
    easeMs: number;
  };
}

export const DEFAULT_SESSION_FILM_CONFIG: SessionFilmConfig = {
  doi: {
    rootImportance: 0.8,
    depthDecay: 0.15,
    recencyDecayPerSecond: 0.01,
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
  layout: {
    arcSpanBaseDeg: 16,
    arcSpanPerLeafDeg: 5,
    arcSpanMaxDeg: 40,
    jitterAngleDeg: 2.5,
    jitterRadiusPx: 6,
    siblingStaggerPx: 14,
  },
  aliveness: {
    bloomBlurStdDeviation: 3,
    glowDecayPerSecond: 0.015,
    glowTickIntervalMs: 400,
    arrivalOvershootScale: 1.18,
    arrivalSettleMs: 480,
    driftAmplitudePx: 10,
    driftPeriodMs: 14_000,
    avatarFloatAmplitudePx: 3,
    avatarFloatPeriodMs: 4_200,
  },
  forceLayout: {
    chargeStrength: -18,
    linkDistance: 48,
    linkStrength: 0.25,
    homeStrength: 0.12,
    tickIntervalMs: 60,
  },
  camera: {
    paddingPx: 60,
    easeMs: 900,
  },
};
