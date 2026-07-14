/**
 * Plant-board gesture dictionary (mt#2377 v2.0 — honest fast-clock motion).
 *
 * THE HONEST-MOTION LAW (mt#2375): every gesture is driven by a real
 * `system_events` row. No event → no motion. Idle reads calm. The dictionary
 * is a fixed vocabulary — one event type maps to one gesture set; nothing
 * here invents motion.
 *
 * Gesture kinds:
 *  - **edge dot** — a dot travels the spine edge (rendered by GestureEdge's
 *    SMIL animateMotion; reduced-motion swaps it for a static brighten).
 *  - **node pulse** — a one-shot glow on an organ node (CSS animation
 *    `vsm-gesture-pulse`, globally reduced-motion-gated).
 *  - **edge flash** — a brief brighten of a non-spine edge (CSS class
 *    `edge-gesture`, reduced-motion-gated).
 *
 * Coverage: the event types with LIVE producers today (see mt#2377 staging
 * note). Declared-but-unemitted types (`session.started`, `pr.merged`,
 * `subagent.completed`, `deploy.build`, `deploy.smoke`) are mapped so their
 * gestures activate the moment mt#2481 / mt#2599 wire the emit sites —
 * mapping an unemitted type costs nothing and is not fake motion (no rows →
 * no gestures).
 *
 * mt#2490 extends the dictionary for the mt#2489 / mt#2537 informational
 * types (`memory.created`, `ask.answered`, `changeset.created`, `hook.fired`,
 * `mcp.disconnect`, `retrospective.fired`, `deploy.*`). See each case below
 * for the gesture-mapping rationale.
 */
import type { SystemEventRow } from "../hooks/useSystemEvents";

/** How long one gesture stays active. */
export const GESTURE_MS = 4_000;

/** Gesture tones — resolve to semantic OKLCH tokens at render time. */
export type GestureTone = "flow" | "healthy" | "warn" | "alarm" | "seam" | "learn";

export const GESTURE_TONE_VARS: Record<GestureTone, string> = {
  flow: "var(--vsm-s1)",
  healthy: "var(--liveness-healthy)",
  warn: "var(--warn-amber)",
  alarm: "var(--warn-red)",
  seam: "var(--vsm-seam)",
  learn: "var(--vsm-learn)",
};

export interface GestureSet {
  /** Spine edges that get a traveling dot. */
  edgeDots: Array<{ edgeId: string; tone: GestureTone }>;
  /** Non-spine edges that get a brightness flash. */
  edgeFlashes: Array<{ edgeId: string; tone: GestureTone }>;
  /** Organ nodes that get a one-shot pulse. */
  nodePulses: Array<{ nodeId: string; tone: GestureTone }>;
}

const EMPTY: GestureSet = { edgeDots: [], edgeFlashes: [], nodePulses: [] };

/** Map a task status (the `newStatus` of a `task.status_changed` row) to its
 *  spine gesture: the dot travels INTO the stage that now holds the task. */
function statusGesture(newStatus: string): GestureSet {
  switch (newStatus) {
    case "TODO":
    case "PLANNING":
      return { ...EMPTY, nodePulses: [{ nodeId: "s1-tasks", tone: "flow" }] };
    case "READY":
      return {
        edgeDots: [{ edgeId: "tasks-to-ready", tone: "flow" }],
        edgeFlashes: [],
        nodePulses: [{ nodeId: "s1-ready", tone: "flow" }],
      };
    case "IN-PROGRESS":
      return {
        edgeDots: [{ edgeId: "ready-to-sessions", tone: "flow" }],
        edgeFlashes: [],
        nodePulses: [{ nodeId: "s1-sessions", tone: "flow" }],
      };
    case "IN-REVIEW":
      return {
        edgeDots: [
          { edgeId: "agents-to-pr", tone: "flow" },
          { edgeId: "pr-to-review", tone: "flow" },
        ],
        edgeFlashes: [],
        nodePulses: [{ nodeId: "s1-review", tone: "flow" }],
      };
    // COMPLETED is a legacy value from pre-mt#2311 event payloads; render like
    // DONE. Safe to remove once the events feed no longer contains pre-2026-07
    // task events.
    case "DONE":
    case "COMPLETED":
      return {
        edgeDots: [{ edgeId: "review-to-done", tone: "healthy" }],
        edgeFlashes: [],
        nodePulses: [{ nodeId: "s1-done", tone: "healthy" }],
      };
    case "BLOCKED":
      return { ...EMPTY, nodePulses: [{ nodeId: "s1-sessions", tone: "warn" }] };
    case "CLOSED":
      return { ...EMPTY, nodePulses: [{ nodeId: "s1-tasks", tone: "warn" }] };
    default:
      return EMPTY;
  }
}

/** The fixed event-type → gesture dictionary. */
export function mapEventToGestures(event: SystemEventRow): GestureSet {
  const payload = event.payload ?? {};
  switch (event.eventType) {
    case "task.status_changed":
      return statusGesture(typeof payload["newStatus"] === "string" ? payload["newStatus"] : "");
    case "task.auto_created":
      // Deliberate orphan (mt#2591): this type is declared in the schema union
      // (system-events-schema.ts) and mapped here, but has NO production emit
      // call site today — no code path actually creates tasks.auto_created
      // rows. Mapping it costs nothing (no rows -> no gestures, honest-motion
      // law holds) and means the gesture activates for free the moment a real
      // auto-creation emit site is wired. That wiring is event-producer work
      // outside this render-side task; it belongs to the mt#2481 family
      // (mt#2537 is the family's most recent shipped emit-wiring slice).
      return { ...EMPTY, nodePulses: [{ nodeId: "s1-tasks", tone: "flow" }] };
    case "session.started":
      return {
        edgeDots: [{ edgeId: "ready-to-sessions", tone: "flow" }],
        edgeFlashes: [],
        nodePulses: [{ nodeId: "s1-sessions", tone: "flow" }],
      };
    case "subagent.completed":
      return { ...EMPTY, nodePulses: [{ nodeId: "s1-agents", tone: "healthy" }] };
    case "subagent.failed":
      return {
        edgeDots: [],
        edgeFlashes: [{ edgeId: "s1-to-learn", tone: "alarm" }],
        nodePulses: [
          { nodeId: "s1-agents", tone: "alarm" },
          { nodeId: "learning-loop", tone: "learn" },
        ],
      };
    case "pr.review_posted": {
      const state = typeof payload["state"] === "string" ? payload["state"] : "";
      if (state === "CHANGES_REQUESTED") {
        return {
          edgeDots: [],
          edgeFlashes: [{ edgeId: "recirc", tone: "warn" }],
          nodePulses: [
            { nodeId: "s1-review", tone: "warn" },
            { nodeId: "s1-sessions", tone: "warn" },
          ],
        };
      }
      return { ...EMPTY, nodePulses: [{ nodeId: "s1-review", tone: "healthy" }] };
    }
    case "pr.merged":
      return {
        edgeDots: [{ edgeId: "review-to-done", tone: "healthy" }],
        edgeFlashes: [],
        nodePulses: [{ nodeId: "s1-done", tone: "healthy" }],
      };
    case "ask.created":
      return {
        edgeDots: [],
        edgeFlashes: [{ edgeId: "s1-to-seam", tone: "seam" }],
        nodePulses: [{ nodeId: "attention-seam", tone: "seam" }],
      };
    case "embeddings.provider_degraded":
      return { ...EMPTY, nodePulses: [{ nodeId: "infra-supply", tone: "alarm" }] };
    case "memory.created":
      // Memory-reservoir glow: the SVG board's reservoir tank lives INSIDE the
      // learning-loop node (see `memory-reservoir` data-testid in
      // LearningLoopNode). The engine only pulses whole nodes, so a memory
      // write pulses the whole learning-loop organ rather than the reservoir
      // sub-element alone — still an honest "something landed here" signal.
      return { ...EMPTY, nodePulses: [{ nodeId: "learning-loop", tone: "learn" }] };
    case "ask.answered":
      // Seam decision-flow: the ANSWER travels back DOWN the seam. Using
      // "seam-to-s5" (the "decision ↓" edge) rather than "s1-to-seam" (the
      // "ask ↑" edge ask.created already flashes) keeps the two ask-lifecycle
      // gestures visually distinct instead of firing the identical motion.
      return {
        edgeDots: [],
        edgeFlashes: [{ edgeId: "seam-to-s5", tone: "seam" }],
        nodePulses: [{ nodeId: "attention-seam", tone: "seam" }],
      };
    case "changeset.created":
      // Review-tank entry: a dot travels the PR→REVIEW pipe segment and the
      // REVIEW organ (the "tank") pulses as the changeset lands in it.
      return {
        edgeDots: [{ edgeId: "pr-to-review", tone: "flow" }],
        edgeFlashes: [],
        nodePulses: [{ nodeId: "s1-review", tone: "flow" }],
      };
    case "hook.fired": {
      // Valve flash: the payload names the DENYING HOOK, not which S2 valve
      // gap it guards (`{ hook, decision, subject? }` — no valve identity).
      // Rather than fake precision by guessing a valve from the hook name,
      // ALL FOUR valves flash together — an honest "an interlock fired
      // somewhere in S2" signal. blocked -> alarm (red); overridden -> warn
      // (amber, v1-unemitted per the schema doc but mapped for free).
      const decision = typeof payload["decision"] === "string" ? payload["decision"] : "";
      const tone: GestureTone = decision === "overridden" ? "warn" : "alarm";
      return {
        edgeDots: [],
        edgeFlashes: [],
        nodePulses: [
          { nodeId: "s2-valve-ready", tone },
          { nodeId: "s2-valve-agents", tone },
          { nodeId: "s2-valve-pr", tone },
          { nodeId: "s2-valve-done", tone },
        ],
      };
    }
    case "mcp.disconnect":
      // Supply-line flicker: infra-supply pulses AND the infra→S1 power line
      // itself flashes, echoing the "supply line" framing literally.
      return {
        edgeDots: [],
        edgeFlashes: [{ edgeId: "infra-to-s1", tone: "warn" }],
        nodePulses: [{ nodeId: "infra-supply", tone: "warn" }],
      };
    case "retrospective.fired":
      // Learning-loop weld: the loop pulses and the "new interlock" edge into
      // the DONE valve flashes — a dictionary-level gesture standing in for
      // the full topology-weld animation, which mt#2602 owns (mt#2490 spec
      // amendment, PR #1784 review).
      return {
        edgeDots: [],
        edgeFlashes: [{ edgeId: "learn-to-s1", tone: "learn" }],
        nodePulses: [{ nodeId: "learning-loop", tone: "learn" }],
      };
    // deploy.* -> S4 node pulse only, NOT a dedicated deploy-pipe edge dot
    // (mt#2490 spec amendment, PR #1784 review): no edge in the current
    // plant topology represents a deploy pipeline — the only edge touching
    // s4-future ("s4-to-tasks") means "roadmap feeds task pool," an
    // unrelated concept. A real deploy-pipe primitive (likely inside the
    // S4 node's own "build -> smoke -> live" chip) is tracked by mt#2605.
    case "deploy.build":
    case "deploy.smoke":
      // In-flight deploy phases: no live producer yet (mt#2599 — the
      // platform-neutral deploy wrapper only observes the terminal record).
      // Mapped now so the gesture activates for free once wired.
      return { ...EMPTY, nodePulses: [{ nodeId: "s4-future", tone: "flow" }] };
    case "deploy.live":
      return { ...EMPTY, nodePulses: [{ nodeId: "s4-future", tone: "healthy" }] };
    case "deploy.fail":
      return { ...EMPTY, nodePulses: [{ nodeId: "s4-future", tone: "alarm" }] };
    default:
      return EMPTY;
  }
}

// ---------------------------------------------------------------------------
// Baseline / diff logic — idle honesty at page load.
// The FIRST poll only establishes the high-water mark: events that happened
// before the operator opened the board are history, not motion. Only rows
// first seen on a SUBSEQUENT poll fire gestures.
// ---------------------------------------------------------------------------

export interface GestureEngineState {
  baselined: boolean;
  seenIds: Set<string>;
}

export function createGestureEngineState(): GestureEngineState {
  return { baselined: false, seenIds: new Set() };
}

/**
 * Feed a poll result through the engine state; returns the events that are
 * NEW since the last poll (empty on the baseline pass). Mutates `state`.
 */
export function takeNewEvents(
  state: GestureEngineState,
  events: SystemEventRow[]
): SystemEventRow[] {
  if (!state.baselined) {
    for (const e of events) state.seenIds.add(e.id);
    state.baselined = true;
    return [];
  }
  const fresh = events.filter((e) => !state.seenIds.has(e.id));
  for (const e of fresh) state.seenIds.add(e.id);
  // Oldest first so a burst of transitions animates in causal order.
  return fresh.reverse();
}
