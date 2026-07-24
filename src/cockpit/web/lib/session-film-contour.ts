/**
 * Touched-set contour (mt#3184 — Watchable world Phase 1, spec SC 7 / AT 5).
 *
 * "Clicking/hovering the avatar draws a smooth isocontour (Bubble-Sets
 * style) around every node that agent has acted on — a hyperedge over the
 * forest, crossing trees freely. It is labeled *touched*, not *context* ...
 * Off by default; per-agent color from the brand's agent-identity tokens."
 *
 * Uses `bubblesets-js` (MIT, verified at planning) — a dependency-free port
 * of Collins/Penn/Carpendale's Bubble Sets algorithm. This module is PURE
 * geometry (no Canvas/DOM dependency: `createOutline` + `PointPath`
 * transforms are plain math), so it runs identically in the browser and in
 * `bun test`.
 *
 * @see session-film-fold.ts — AgentFoldState.touchedEntityIds, the input set
 * @see session-film-layout.ts — StageLayout, the node positions this reads
 * @see session-film-config.ts — contour styling knobs (the ONE tunables object)
 */
import { circle, createOutline, type ICircle } from "bubblesets-js";
import type { EventRealm } from "@minsky/domain/transcripts/event-schema";
import type { AgentFoldState } from "./session-film-fold";
import type { StageLayout } from "./session-film-layout";
import type { SessionFilmConfig } from "./session-film-config";

/**
 * Member circles for an agent's touched-set contour — one per touched
 * entity CURRENTLY VISIBLE on the stage (a collapsed-out-of-budget node
 * contributes no circle; the contour only ever bubbles what's actually
 * rendered, never an invented position for a hidden node).
 */
export function touchedSetMemberCircles(
  agent: Pick<AgentFoldState, "touchedEntityIds">,
  layout: StageLayout,
  radius: number
): ICircle[] {
  const circles: ICircle[] = [];
  for (const node of layout.nodes) {
    if (node.entityId && agent.touchedEntityIds.has(node.entityId)) {
      circles.push(circle(node.x, node.y, radius));
    }
  }
  return circles;
}

/**
 * Distinct realms spanned by an agent's currently-visible touched set — the
 * "crosses trees" property AT 5 exercises directly (a cross-realm fixture
 * must span >= 2 realms).
 */
export function touchedSetRealms(
  agent: Pick<AgentFoldState, "touchedEntityIds">,
  layout: StageLayout
): Set<EventRealm> {
  const realms = new Set<EventRealm>();
  for (const node of layout.nodes) {
    if (node.entityId && agent.touchedEntityIds.has(node.entityId)) {
      realms.add(node.realm);
    }
  }
  return realms;
}

/**
 * Compute the smoothed SVG path `d` string for an agent's touched-set
 * contour, or `null` when there are fewer than 2 currently-visible touched
 * nodes (nothing meaningful to bubble around a single point).
 */
export function computeTouchedSetContourPath(
  agent: Pick<AgentFoldState, "touchedEntityIds">,
  layout: StageLayout,
  config: SessionFilmConfig
): string | null {
  const members = touchedSetMemberCircles(agent, layout, config.contour.padding);
  if (members.length < 2) return null;
  const outline = createOutline(members, [], []);
  const smoothed = outline.sample(8).simplify(0).bSplines().simplify(0);
  return smoothed.toString();
}

/**
 * Per-agent contour color, drawn from the SAME brand agent-identity tokens
 * as the avatar fills (`SessionFilmStage.tsx`'s `outcomeClassName`
 * sibling) — policy=warn-red, principal=signal-cyan, agent=iso.pastel (the
 * brand's reserved companion-overlay color).
 */
export function touchedSetContourColorClass(agent: Pick<AgentFoldState, "kind">): string {
  if (agent.kind === "policy") return "stroke-warn-red fill-warn-red";
  if (agent.kind === "principal") return "stroke-signal-cyan fill-signal-cyan";
  return "stroke-iso-pastel fill-iso-pastel";
}
