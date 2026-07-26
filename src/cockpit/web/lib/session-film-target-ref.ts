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
