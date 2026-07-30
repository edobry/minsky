/**
 * Beam-with-outcome-physics for the session film's stage (mt#3231 SC 7 /
 * AT 7 — "a beam on EVERY action, not just batches").
 *
 * v1.1 (`SessionFilmStage.tsx`) only drew a beam for a genuine PARALLEL
 * batch (`fanOutTargetIds` — >1 simultaneous target for one actor); a
 * singleton (non-batch) action just moved the avatar with no pulse at all —
 * the operator's exact complaint ("it goes somewhere and something happens
 * but it's not clear it's doing stuff"). This module is the pure-logic half
 * of the fix: given an actor's CURRENT folded action (its `lastVerb` /
 * `lastOutcome` / `currentTargetId` on `AgentFoldState`), decide whether a
 * beam should render for it and what "outcome physics" it carries — the
 * RFC's "actions are pulses with outcome physics" MVP framing (Notion
 * `3a7937f0-3cb4-81ae-8f78-e7a5d5415d0a`), same vocabulary as the
 * fan-out-beam neighbor this module now has a singleton-action sibling for.
 *
 * Physics table (spec SC 7, verbatim):
 *   - `read`/`search` — PULL: energy flows FROM the target back to the
 *     agent (the agent is drawing information home). `search` gets its own
 *     "fan" treatment (diffuse, not a single directed pull) since a search
 *     doesn't resolve to one fixed target the way a read does.
 *   - `write`/`create` — PUSH: energy flows FROM the agent OUT to the target.
 *   - `delete` — LOUD: a push, but rendered louder/more distinct (the
 *     mutation an operator most wants to notice).
 *   - any `error` outcome — BOUNCE: overrides verb-based direction; the
 *     beam recoils rather than completing its journey.
 *   - any `denied` outcome — POLICY: overrides verb-based direction; the
 *     guard-denial beam, distinct from an ordinary error.
 *
 * Outcome-based kinds take priority over verb-based kinds (an errored WRITE
 * still reads as "bounce," not "push" — the failure is the more important
 * signal to the operator than the attempted direction).
 *
 * Conversational verbs (`wait`/`speak`/`think`/`ask`/`respond`) have no
 * externally-observable target (`session-film-fold.ts`'s
 * `CONVERSATIONAL_VERBS`) and never produce a beam — there is nothing to
 * beam TO.
 *
 * @see SessionFilmStage.tsx — fan-out beams (the existing >1-target case
 *   this module's singleton case sits alongside) + the render wiring
 * @see session-film-config.ts — `motion.beamDurationMs`, the tunable this
 *   module's caller uses for the pulse animation duration
 */
import type { EventOutcome, EventVerb } from "@minsky/domain/transcripts/event-schema";
import type { AgentFoldState } from "./session-film-fold";

export type BeamKind = "pull" | "push" | "fan" | "loud" | "bounce" | "policy";

/** Verbs with no target-directed beam — see the module doc's "conversational verbs" note. */
const NO_BEAM_VERBS: ReadonlySet<EventVerb> = new Set(["wait", "speak", "think", "ask", "respond"]);

/**
 * Decide the beam kind for an agent's CURRENT folded action, or `null` when
 * no beam should render (at home / no target / a conversational verb with
 * nothing to beam to). Outcome (`error`/`denied`) takes priority over verb —
 * see the module doc's physics table.
 */
export function beamKindForAgent(
  currentTargetId: string | null,
  lastVerb: EventVerb | null,
  lastOutcome: EventOutcome | undefined
): BeamKind | null {
  if (!currentTargetId || !lastVerb) return null;
  if (NO_BEAM_VERBS.has(lastVerb)) return null;
  if (lastOutcome === "denied") return "policy";
  if (lastOutcome === "error") return "bounce";
  switch (lastVerb) {
    case "read":
      return "pull";
    case "search":
      return "fan";
    case "write":
    case "create":
      return "push";
    case "delete":
      return "loud";
    default:
      return null; // execute/spawn/clone: has a target but no directional beam physics defined here
  }
}

/** Convenience overload reading straight off an `AgentFoldState`. */
export function beamKindForAgentState(agent: AgentFoldState): BeamKind | null {
  return beamKindForAgent(agent.currentTargetId, agent.lastVerb, agent.lastOutcome);
}

export interface BeamEndpoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Endpoint order for a beam's `<line>` — PULL beams run target→home (energy
 * flows toward the agent), every other kind runs home→target. The direction
 * is purely a rendering convenience (a marker/gradient could use it); the
 * kind itself is the authoritative "what happened" signal (see
 * `beamClassName` / `data-beam-kind` at the call site).
 */
export function beamEndpoints(
  kind: BeamKind,
  home: { x: number; y: number },
  target: { x: number; y: number }
): BeamEndpoints {
  if (kind === "pull") {
    return { x1: target.x, y1: target.y, x2: home.x, y2: home.y };
  }
  return { x1: home.x, y1: home.y, x2: target.x, y2: target.y };
}

/** Tailwind/semantic-token stroke treatment per beam kind — never a raw hex. */
export function beamClassName(kind: BeamKind): string {
  switch (kind) {
    case "pull":
      return "stroke-signal-cyan";
    case "push":
      return "stroke-signal-cyan";
    case "fan":
      return "stroke-signal-cyan";
    case "loud":
      return "stroke-warn-red";
    case "bounce":
      return "stroke-warn-red";
    case "policy":
      return "stroke-warn-red";
    default:
      return "stroke-muted-foreground";
  }
}

/** Stroke width per beam kind — "loud" (delete) and "bounce"/"policy" (failure) read heavier than an ordinary pull/push/fan. */
export function beamStrokeWidth(kind: BeamKind): number {
  switch (kind) {
    case "loud":
      return 2.5;
    case "bounce":
    case "policy":
      return 2;
    default:
      return 1.5;
  }
}

/** Dash pattern per beam kind — "fan" (diffuse search) and "policy" (blocked) get a distinct dash from the solid pull/push line; "bounce" gets the tightest dash (agitated). */
export function beamDashArray(kind: BeamKind): string | undefined {
  switch (kind) {
    case "fan":
      return "2,3";
    case "policy":
      return "4,2";
    case "bounce":
      return "1,3";
    default:
      return undefined;
  }
}
