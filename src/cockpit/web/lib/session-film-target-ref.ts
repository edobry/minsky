/**
 * Session-film target labeling (mt#3226 SC 2 / AT 3 — glyphic ribbon rows).
 *
 * A ribbon row's target label reuses the mt#3174 EntityRef layer when the
 * touched target is a MINSKY-SUBSTRATE entity with a routable id-space
 * counterpart (task/ask/memory/changeset/session) — the synthetic composite
 * id shape `minsky:<entityKind>:<ref>` (event-schema.ts's `EventTarget` doc
 * comment) is produced by `event-adapter.ts`'s `minskySubstrateTargetExtractor`
 * for exactly these five entity kinds (`task`, `ask`, `memory`, `changeset`,
 * `workspace` — the last maps to EntityRef's `session` RoutableEntityType per
 * ADR-022: a workspace clone IS the session-record id-space). Every other
 * realm (repo/web/notion/shell/agents) has no routable id-space counterpart
 * in v0 and falls back to a plain display label.
 *
 * @see packages/domain/src/transcripts/event-schema.ts — EventTarget id shapes
 * @see packages/domain/src/transcripts/event-adapter.ts — minskySubstrateTargetExtractor
 * @see src/cockpit/web/lib/entity-codec.ts — RoutableEntityType / the mt#3174 id-space
 */
import type { EventRealm } from "@minsky/domain/transcripts/event-schema";
import type { RoutableEntityType } from "./entity-codec";

/** The subset of `EventTarget` this module reads. */
export interface TargetLike {
  realm: EventRealm;
  id: string;
}

/** Maps `event-adapter.ts`'s `minskySubstrateTargetExtractor` entity-kind strings to EntityRef's routable types. */
const ENTITY_KIND_TO_ROUTABLE: Readonly<Record<string, RoutableEntityType>> = {
  task: "task",
  ask: "ask",
  memory: "memory",
  changeset: "changeset",
  // A workspace clone is the SessionRecord id-space (ADR-022: "workspace" is
  // the new-vocabulary name for what the `session` RoutableEntityType/route
  // already addresses — /agents/:id, NOT a rename of that route).
  workspace: "session",
};

export interface RoutableTargetRef {
  type: RoutableEntityType;
  id: string;
}

/**
 * Parse a minsky-substrate synthetic target id into a routable entity
 * reference the shared `EntityRef` component can render, or `null` when the
 * target isn't a minsky-substrate entity reference (any other realm), the
 * entity kind has no routable counterpart, or the adapter fell back to its
 * `"unknown"` ref placeholder (nothing to link to).
 */
export function parseRoutableTarget(target: TargetLike): RoutableTargetRef | null {
  if (target.realm !== "minsky-substrate") return null;
  const parts = target.id.split(":");
  if (parts.length < 3 || parts[0] !== "minsky") return null;
  const kind = parts[1] ?? "";
  const ref = parts.slice(2).join(":");
  const routable = ENTITY_KIND_TO_ROUTABLE[kind];
  if (!routable || ref.length === 0 || ref === "unknown") return null;
  return { type: routable, id: ref };
}

/**
 * Fallback plain-text label for a target with no routable EntityRef
 * counterpart — strips the realm-prefix scaffolding from the synthetic
 * composite id so the ribbon shows a readable fragment (a file path, a
 * domain, a shell command digest) rather than the raw `realm:...` id.
 */
export function targetDisplayLabel(target: TargetLike): string {
  const { realm, id } = target;
  if (realm === "repo" && id.startsWith("file:")) {
    const rest = id.slice("file:".length);
    const sepIdx = rest.indexOf(":");
    return sepIdx >= 0 ? rest.slice(sepIdx + 1) : rest;
  }
  for (const prefix of ["web:", "notion:", "shell:", "agents:"]) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return id;
}

// ── Self-reference elision (mt#3231 SC 1 / AT 1) ─────────────────────────────
//
// Finding 1 (v1.2 diagnosis, verified against v1.1 source): the ribbon's
// ACTOR column is correctly suppressed except on change
// (`session-film-batches.ts`'s `deriveActorChanges`) — the repetition
// complaint is the TARGET column. `event-adapter.ts`'s `emitSimpleEvent`
// targets every conversational verb (`speak`/`think`) at
// `agents:${context.agentSessionId}` — THIS transcript's own agent, i.e. the
// film's subject acting on itself — and its `ask` event (the principal's
// prompt reaching the subject) targets the SAME id from the OTHER side. For
// a single-subject film (v0 scope), that id is constant across the whole
// event stream, so it prints as the same raw `agent-<hex>` chip on nearly
// every row — never a MEANINGFUL cross-reference (unlike a real spawned
// child's `agents:<kind>` target, which has a DIFFERENT id and stays
// informative).

/**
 * Derive the film's own subject-agent target id — the `agents:<id>` shape
 * that a definitively self-targeting event (an agent-kind actor whose
 * conversational verb targets `agents:<that same actor's own id>`) reveals.
 * Returns the FIRST such id found (deterministic, order-stable across
 * re-renders) or `null` when no event unambiguously self-targets (e.g. an
 * events array containing only tool-call events with real targets).
 */
export function deriveFilmSubjectAgentId(
  events: readonly { actor: { kind: string; agentSessionId?: string }; target: TargetLike }[]
): string | null {
  for (const event of events) {
    if (
      event.actor.kind !== "agent" ||
      !event.actor.agentSessionId ||
      event.target.realm !== "agents"
    ) {
      continue;
    }
    // ASSUMPTION this derivation rests on (mt#3231 review R1, non-blocking
    // #7): every current adapter targets a self-verb at EXACTLY
    // `agents:<agentSessionId>` — no additional namespacing
    // (`event-adapter.ts`'s `emitSimpleEvent`). Exact equality is the
    // primary check.
    //
    // Defensive fallback: a future or alternate adapter that namespaces
    // agent ids differently (e.g. multi-tenant `agents:<tenant>:<id>`) would
    // fail the exact check but still genuinely self-target if its id ENDS
    // with this actor's own session id. Suffix (not substring) match, with
    // the mandatory leading `:` separator, avoids a false positive against
    // an unrelated id that merely contains this session id as a fragment
    // (e.g. it would NOT wrongly match `agents:Explore` for session id
    // `"1"` — "Explore" doesn't end with ":1").
    if (event.target.id.endsWith(`:${event.actor.agentSessionId}`)) {
      return event.target.id;
    }
  }
  return null;
}

/** True when `target` IS the film's own subject agent (see {@link deriveFilmSubjectAgentId}) — elide to a self-reference rather than repeating the raw id. */
export function isSelfReferenceTarget(target: TargetLike, subjectAgentId: string | null): boolean {
  return subjectAgentId !== null && target.realm === "agents" && target.id === subjectAgentId;
}

/** Compact self-reference label — an inward glyph, never the raw repeated agent id (spec SC 1). */
export const SELF_REFERENCE_LABEL = "↳ self";
