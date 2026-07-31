/**
 * Living layout — a d3-force simulation over the stage's touched-set
 * (mt#3231 SC 4 / AT 4, the A2->A3 motion climb).
 *
 * v1.1 (`session-film-layout.ts`'s `computeStageLayout`) is a COMPUTE-ONCE
 * deterministic tidy-tree: every render recomputes the whole layout from
 * scratch and CSS transitions ease the visual jump between two static
 * snapshots. The operator's finding: even with those transitions, the world
 * "still feels static" next to Gource's continuously-alive layout. This
 * module adds a LIVE simulation layer on top of `computeStageLayout`'s
 * output — nodes settle and gently drift under simulated forces instead of
 * jumping between fixed slots.
 *
 * ## Warm start, not chaos
 *
 * A node's simulated position is SEEDED from its tidy-tree coordinate
 * (`createForceLayout`) — never a random scatter. A `forceX`/`forceY` pair
 * per node continuously springs it back toward that SAME nominal slot
 * (`config.forceLayout.homeStrength`), so `forceManyBody` repulsion and
 * `forceLink` link tension only add gentle organic perturbation around the
 * tidy-tree's own arrangement — the realm-radial structure survives, it
 * just breathes instead of sitting rigid.
 *
 * ## Anchored roots
 *
 * Every realm root gets `fx`/`fy` pinned to its FIXED compass bearing
 * (`session-film-config.ts`'s `REALM_BEARINGS_DEG`) — the spec's "anchor/
 * pin realm roots so compass + spatial memory hold." Roots never drift
 * regardless of the forces below; only their children breathe.
 *
 * ## Re-flow on arrival
 *
 * `mergeForceLayout` is the "nodes... re-flow as siblings arrive" half of
 * the spec: a node id already tracked KEEPS its live simulated x/y/vx/vy —
 * it never snaps. A brand-new id is warm-started at its own tidy-tree slot.
 * Either way the simulation's `alpha` is reheated so the arrival visibly
 * perturbs its neighbors before re-settling, rather than popping in inert.
 *
 * ## Honest-motion carve-out (spec directive 8)
 *
 * This is EVENT-anchored motion, not the ambient register
 * (`SessionFilmStage.tsx`'s separately-documented camera-drift/idle-float
 * carve-out): every node this simulation moves is a node that EXISTS
 * because a real fold event touched it (`computeStageLayout`'s output is
 * itself entirely event-driven). The simulation only redistributes
 * already-real nodes among themselves — it never invents a node, a touch,
 * or a beam. It stays within the plant board's honest-motion law.
 *
 * ## reduced-motion
 *
 * `settleForceLayoutOnce` synchronously ticks the simulation to convergence
 * (bounded at `MAX_SYNC_TICKS`) ONE time and never again — "settle once,
 * then freeze" (spec AT 4). The caller (`useSessionFilmForceLayout`) must
 * not call `tickForceLayout` again afterward for the same state.
 *
 * @see session-film-layout.ts — `computeStageLayout`, the tidy-tree this warm-starts from
 * @see session-film-config.ts — `forceLayout` tunables
 * @see ../hooks/useSessionFilmForceLayout.ts — the React wiring (tick loop / reduced-motion gating)
 */
import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { StageLayout, StageLayoutNode } from "./session-film-layout";
import type { SessionFilmConfig } from "./session-film-config";

/** One simulated node — extends d3-force's own mutable datum (x/y/vx/vy/fx/fy are written IN PLACE by the simulation). */
export interface ForceNode extends SimulationNodeDatum {
  id: string;
  /** The node's NOMINAL (tidy-tree) slot — what forceX/forceY continuously spring it back toward. */
  nominalX: number;
  nominalY: number;
}

type ForceLinkDatum = SimulationLinkDatum<ForceNode>;

export interface ForceLayoutState {
  simulation: Simulation<ForceNode, ForceLinkDatum>;
  nodesById: Map<string, ForceNode>;
}

/** Simulation is considered SETTLED once alpha decays below this (velocities -> ~0). */
const ALPHA_MIN = 0.01;
/** Alpha to reheat to when a brand-new node arrives — visible-but-bounded perturbation, never a random re-scatter. */
const REHEAT_ALPHA = 0.4;
/**
 * Warm-start alpha for a FRESHLY created simulation (mt#3231 review R1,
 * BLOCKING — "readForceLayoutPositions returns stale nominal positions
 * before the first tick, causing a jump when the first tick applies
 * forces"). d3-force's OWN default starting alpha is 1 — the strongest force
 * magnitude any tick can ever apply (alpha directly scales every force's
 * per-tick velocity contribution). Every node here warm-starts EXACTLY at
 * its tidy-tree nominal slot (see `createForceLayout`/`toForceNode` below —
 * never a random scatter), so up until the caller's FIRST real tick fires
 * (`useSessionFilmForceLayout`'s interval, `tickIntervalMs` after mount),
 * the scene has only ever been rendered motionless at that exact nominal
 * layout. An alpha=1 first tick would then apply the single LARGEST
 * perturbation this simulation ever produces to a scene the viewer has only
 * seen sitting still — a visible one-frame "jump," not the gentle organic
 * breathing every other tick settles into. Starting cooler makes that first
 * visible tick a small, continuous nudge instead, consistent with every
 * later tick's magnitude.
 *
 * Deliberately NOT applied to `REHEAT_ALPHA` above: the arrival reheat's
 * visible perturbation of NEIGHBORING (already-rendered, already-moving)
 * nodes is a DELIBERATE, spec-mandated effect ("the arrival visibly
 * perturbs its neighbors before re-settling, rather than popping in inert"
 * — module doc's "Re-flow on arrival" section) — not the accidental
 * cold-start artifact this constant fixes.
 */
const INITIAL_ALPHA = 0.15;
/** Bound on synchronous ticks for the reduced-motion one-shot settle — d3-force's default decay reaches ALPHA_MIN well within this even from full alpha=1 (a safe upper bound; the actual starting points below are cooler). */
const MAX_SYNC_TICKS = 300;

/** Mirrors `SessionFilmStage.tsx`'s "Realm-tree edges" pass: parent = same realm, one depth shallower. */
function findParent(
  nodes: readonly StageLayoutNode[],
  node: StageLayoutNode
): StageLayoutNode | undefined {
  return nodes.find((n) => n.realm === node.realm && n.depth === node.depth - 1);
}

function buildLinks(nodes: readonly StageLayoutNode[]): ForceLinkDatum[] {
  const links: ForceLinkDatum[] = [];
  for (const node of nodes) {
    if (node.depth === 0) continue;
    const parent = findParent(nodes, node);
    if (parent) links.push({ source: parent.id, target: node.id });
  }
  return links;
}

function toForceNode(node: StageLayoutNode): ForceNode {
  const isRoot = node.depth === 0;
  return {
    id: node.id,
    x: node.x,
    y: node.y,
    nominalX: node.x,
    nominalY: node.y,
    fx: isRoot ? node.x : null,
    fy: isRoot ? node.y : null,
  };
}

function applyForces(
  simulation: Simulation<ForceNode, ForceLinkDatum>,
  links: ForceLinkDatum[],
  config: SessionFilmConfig
): void {
  simulation
    .force("charge", forceManyBody<ForceNode>().strength(config.forceLayout.chargeStrength))
    .force(
      "link",
      forceLink<ForceNode, ForceLinkDatum>(links)
        .id((d) => d.id)
        .distance(config.forceLayout.linkDistance)
        .strength(config.forceLayout.linkStrength)
    )
    .force("x", forceX<ForceNode>((d) => d.nominalX).strength(config.forceLayout.homeStrength))
    .force("y", forceY<ForceNode>((d) => d.nominalY).strength(config.forceLayout.homeStrength));
}

/**
 * Create a fresh force-layout state, warm-started from a `StageLayout`'s
 * tidy-tree positions. The simulation is `.stop()`'d immediately — the
 * caller ticks explicitly (deterministic, testable, and required for the
 * reduced-motion one-shot settle).
 */
export function createForceLayout(
  layout: StageLayout,
  config: SessionFilmConfig
): ForceLayoutState {
  const nodesById = new Map<string, ForceNode>();
  for (const node of layout.nodes) {
    nodesById.set(node.id, toForceNode(node));
  }
  const forceNodes = [...nodesById.values()];
  const simulation = forceSimulation<ForceNode>(forceNodes).alpha(INITIAL_ALPHA).stop();
  applyForces(simulation, buildLinks(layout.nodes), config);
  return { simulation, nodesById };
}

/**
 * Merge a freshly-recomputed `StageLayout` into an EXISTING force-layout
 * state — the "re-flow as siblings arrive" half of the spec. A previously-
 * tracked node id keeps its LIVE simulated x/y/vx/vy (never snaps); its
 * `nominalX/Y` (and, for a root, its pin) still track the newly recomputed
 * tidy-tree slot, since sibling counts/DOI can shift that even for an
 * already-known node. A brand-new id is warm-started fresh. Reheats alpha
 * only when a genuinely new node arrived.
 */
export function mergeForceLayout(
  state: ForceLayoutState,
  layout: StageLayout,
  config: SessionFilmConfig
): ForceLayoutState {
  const nodesById = new Map<string, ForceNode>();
  let hasNewArrival = false;

  for (const node of layout.nodes) {
    const isRoot = node.depth === 0;
    const existing = state.nodesById.get(node.id);
    if (existing) {
      existing.nominalX = node.x;
      existing.nominalY = node.y;
      existing.fx = isRoot ? node.x : null;
      existing.fy = isRoot ? node.y : null;
      nodesById.set(node.id, existing);
    } else {
      hasNewArrival = true;
      nodesById.set(node.id, toForceNode(node));
    }
  }

  const forceNodes = [...nodesById.values()];
  state.simulation.nodes(forceNodes);
  applyForces(state.simulation, buildLinks(layout.nodes), config);

  if (hasNewArrival) {
    state.simulation.alpha(Math.max(state.simulation.alpha(), REHEAT_ALPHA));
  }

  return { simulation: state.simulation, nodesById };
}

/** Advance the simulation by exactly one tick (mutates node x/y/vx/vy in place). */
export function tickForceLayout(state: ForceLayoutState): void {
  state.simulation.tick();
}

/** True once the simulation has decayed below its settle threshold — velocities have converged toward ~0. */
export function isForceLayoutSettled(state: ForceLayoutState): boolean {
  return state.simulation.alpha() < ALPHA_MIN;
}

/** Read current LIVE positions (post-tick), keyed by node id. */
export function readForceLayoutPositions(
  state: ForceLayoutState
): ReadonlyMap<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const [id, node] of state.nodesById) {
    positions.set(id, { x: node.x ?? node.nominalX, y: node.y ?? node.nominalY });
  }
  return positions;
}

/**
 * Reduced-motion one-shot settle (spec AT 4: "yields a single settle then
 * no further motion"): synchronously ticks until the simulation converges
 * or `MAX_SYNC_TICKS` is reached, then stops for good. The caller must not
 * tick this state again afterward.
 */
export function settleForceLayoutOnce(state: ForceLayoutState): void {
  for (let i = 0; i < MAX_SYNC_TICKS && !isForceLayoutSettled(state); i++) {
    state.simulation.tick();
  }
}
