/**
 * Entity-node receipt resolution (mt#3184 — Watchable world Phase 1, spec
 * SC 8 / AT 6): "Every entity node deep-links via the existing entity codec
 * (`minsky://` five types for Minsky entities; file/web/notion nodes
 * resolve to their natural targets)."
 *
 * Pure id-shape parsing (mirrors `event-adapter.ts`'s `EventTarget.id`
 * synthetic-composite-id doc comment) — no React, no router dependency, so
 * it's testable standalone. The stage component consumes this to decide
 * whether to render an `EntityRef` (mt#3174), an external `<a>`, or a
 * non-navigable path/label.
 */
import type { RoutableEntityType } from "./entity-codec";

export type ResolvedEntityLink =
  | { kind: "minsky"; entityType: RoutableEntityType; entityId: string }
  | { kind: "external"; label: string; href: string }
  | { kind: "path"; label: string; path: string }
  | { kind: "none"; label: string };

/**
 * `event-adapter.ts`'s `sessionCloneTargetExtractor` emits
 * `minsky:workspace:<ref>`, but the entity codec's routable type for a
 * workspace/session id is `"session"` (ADR-022 stage 1 — `minsky://session/`
 * keeps naming the WORKSPACE id-space). This is the one naming seam between
 * the event schema's target-id vocabulary and the codec's URI-type
 * vocabulary; every other minsky-substrate kind (`task`, `ask`, `memory`,
 * `changeset`) already matches verbatim.
 */
const SUBSTRATE_KIND_TO_ROUTABLE_TYPE: Record<string, RoutableEntityType> = {
  task: "task",
  ask: "ask",
  memory: "memory",
  changeset: "changeset",
  workspace: "session",
};

function splitOnce(rest: string): { head: string; tail: string } {
  const idx = rest.indexOf(":");
  return idx >= 0
    ? { head: rest.slice(0, idx), tail: rest.slice(idx + 1) }
    : { head: rest, tail: "" };
}

/** Resolve an `EventTarget`'s synthetic composite id to a receipt link. */
export function resolveEntityLink(target: { id: string }): ResolvedEntityLink {
  const { id } = target;

  if (id.startsWith("file:")) {
    const rest = id.slice("file:".length);
    const { tail } = splitOnce(rest);
    const path = tail.length > 0 ? tail : rest;
    return { kind: "path", label: path, path };
  }

  if (id.startsWith("web:")) {
    const domain = id.slice("web:".length);
    return { kind: "external", label: domain, href: `https://${domain}` };
  }

  if (id.startsWith("notion:")) {
    const pageId = id.slice("notion:".length);
    return { kind: "external", label: pageId, href: `https://notion.so/${pageId}` };
  }

  if (id.startsWith("minsky:")) {
    const rest = id.slice("minsky:".length);
    const { head: kindRaw, tail: entityId } = splitOnce(rest);
    const routableType = SUBSTRATE_KIND_TO_ROUTABLE_TYPE[kindRaw];
    if (routableType && entityId) {
      return { kind: "minsky", entityType: routableType, entityId };
    }
    return { kind: "none", label: id };
  }

  // shell:<cmd>, agents:<kind-or-id>, unknown:<name> — no natural navigable
  // target in v0 (a shell command and a bare agent-kind reference aren't
  // entities with a home page). Render as a plain non-navigable label.
  return { kind: "none", label: id };
}
