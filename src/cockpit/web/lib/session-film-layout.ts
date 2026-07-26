/**
 * Stage layout: collapsed world-forest, DOI-driven expansion, deterministic
 * ORGANIC radial-arc tree per realm (mt#3184 SC 5; organic-layout redesign
 * mt#3226 SC 5).
 *
 * Realm trees root at FIXED compass bearings around the agent's home
 * (`session-film-config.ts`'s `REALM_BEARINGS_DEG`) and lay out radially
 * OUTWARD using `d3-hierarchy`'s deterministic tidy-tree algorithm for
 * sibling ORDERING/PROPORTION — no force simulation (spec SC 5 / directive
 * 3). Each realm's raw containment tree is built from the touched entities'
 * synthetic composite ids (`event-schema.ts`'s `EventTarget.id` doc
 * comment): `repo` targets carry real path structure (split on `/`), every
 * other realm is a flat root->entity tree in v0 — the adapter carries no
 * deeper containment for those realms yet (an honest v0 approximation, not
 * an invented hierarchy).
 *
 * ## Organic child layout (mt#3226 SC 5)
 *
 * The PREVIOUS scheme converted d3's normalized sibling position into a
 * Cartesian PERPENDICULAR offset (`spread = x * siblingSpacing * leafCount`)
 * from a single point at a fixed radial distance — an offset that grows
 * UNBOUNDED with child count. At high fanout (the operator's 2026-07-25
 * screenshot: minsky-substrate 25 children, shell 32) this degenerated into
 * a rigid straight line running off-viewport — a "comb" for an oblique
 * bearing (the perpendicular direction is itself diagonal), a flat "fan"
 * for a cardinal one.
 *
 * The fix converts d3's normalized sibling position (`d.x`, already
 * subtree-proportioned by the tidy-tree algorithm — deeper nodes inherit a
 * SLICE of their parent's angular allocation, not a re-derived one) into an
 * ANGLE within a bounded arc centered on the realm's bearing, rather than a
 * linear Cartesian offset — the standard "radial tree" reinterpretation of
 * a tidy-tree's Cartesian output (angle = f(x), radius = f(depth)):
 *
 *   - **Adaptive-but-capped arc span** (`config.layout.arcSpan{Base,PerLeaf,Max}Deg`):
 *     grows with `sqrt(leafCount)` (a busy realm gets more room; a sparse
 *     one doesn't waste angular budget — "kill the dead-space imbalance")
 *     but is HARD-CAPPED safely under the 45deg gap between adjacent fixed
 *     realm bearings, so a high-fanout realm's fan never crosses into a
 *     neighboring realm's sector regardless of child count.
 *   - **Deterministic per-node jitter** (`seededJitter` above): a small
 *     angular + radial offset, seeded by the node's own id — organic
 *     irregularity that is IDENTICAL across re-renders and replays (no
 *     `Math.random()`).
 *   - **Collision-aware radial stagger** (`config.layout.siblingStaggerPx`):
 *     alternates same-depth siblings between two radii by sibling-index
 *     parity, so a dense fan of children doesn't render as a single flat
 *     overlapping ring — adjacent siblings differ in RADIUS, not just the
 *     (potentially tiny, at high fanout) angular gap between them.
 *
 * Full iterative collision-solving (a force pass, or per-pair repulsion) is
 * deliberately NOT implemented here — the arc-span cap + stagger + jitter
 * combination is the v1.1 treatment; see mt#3226's PR body for the explicit
 * scope call.
 *
 * Degree-of-interest (Card & Nation 2002, Furnas 1986): interest = a-priori
 * importance (root floor, decaying per depth level) + recency (an
 * exponential decay of elapsed wall-clock time since the entity's last
 * touch — see session-film-config.ts's doc comment on
 * `recencyDecayPerSecond` for why this is elapsed-TIME- rather than
 * batch-row-distance-based in v0). A node expands when its score clears
 * `config.doi.expandThreshold`, OR it lies on the root-to-touched-node path
 * of any expanded descendant (spec: "the path from root to any touched node
 * auto-expands"). The combined visible-node count across all realms is
 * capped at `config.doi.visibleNodeBudget` — lowest-scoring nodes are
 * dropped first when over budget.
 *
 * @see session-film-fold.ts — WorldFoldState / EntityFoldState this layout reads
 * @see session-film-config.ts — REALM_BEARINGS_DEG + the ONE tunables object
 */
import { hierarchy, tree as d3tree, type HierarchyNode } from "d3-hierarchy";
import type { EventRealm } from "@minsky/domain/transcripts/event-schema";
import { EVENT_REALMS } from "@minsky/domain/transcripts/event-schema";
import type { EntityFoldState, WorldFoldState } from "./session-film-fold";
import {
  REALM_BEARINGS_DEG,
  REALM_DISPLAY_LABEL,
  type SessionFilmConfig,
} from "./session-film-config";
import { targetDisplayLabel } from "./session-film-target-ref";

// ── Deterministic per-node jitter (mt#3226 SC 5) ─────────────────────────────
//
// FNV-1a string hash -> a stable unit value in [0, 1) for a given seed. Pure
// function of the seed string: same node id -> same jitter, every render and
// every replay (spec: "seeded by node id, so replays are stable") — no
// `Math.random()` anywhere in the layout.
function hashUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Deterministic angular + radial jitter for one node, seeded by its own id. */
function seededJitter(
  nodeId: string,
  config: SessionFilmConfig
): { angleRad: number; radiusPx: number } {
  const angleUnit = hashUnit(`${nodeId}|angle`) * 2 - 1; // [-1, 1)
  const radiusUnit = hashUnit(`${nodeId}|radius`) * 2 - 1;
  return {
    angleRad: (angleUnit * config.layout.jitterAngleDeg * Math.PI) / 180,
    radiusPx: radiusUnit * config.layout.jitterRadiusPx,
  };
}

// ── Raw containment tree (pre-d3) ────────────────────────────────────────

interface RawNode {
  id: string;
  label: string;
  /** The underlying touched entity id when this node maps to a real touch, else null (a synthetic realm root / path segment). */
  entityId: string | null;
  children: RawNode[];
}

function realmRootId(realm: EventRealm): string {
  return `${realm}:__root__`;
}

/** Build the repo realm's real directory tree from touched file paths. */
function buildRepoTree(realm: EventRealm, entityIds: readonly string[]): RawNode {
  const root: RawNode = { id: realmRootId(realm), label: realm, entityId: null, children: [] };
  const index = new Map<string, RawNode>([["", root]]);

  for (const entityId of entityIds) {
    const rest = entityId.startsWith("file:") ? entityId.slice("file:".length) : entityId;
    const sepIdx = rest.indexOf(":");
    const path = sepIdx >= 0 ? rest.slice(sepIdx + 1) : rest;
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;

    let accum = "";
    let parent = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      accum = accum ? `${accum}/${seg}` : seg;
      const isLeaf = i === segments.length - 1;
      let node = index.get(accum);
      if (!node) {
        node = {
          id: `${realm}:${accum}`,
          label: seg,
          entityId: isLeaf ? entityId : null,
          children: [],
        };
        index.set(accum, node);
        parent.children.push(node);
      } else if (isLeaf) {
        node.entityId = entityId;
      }
      parent = node;
    }
  }
  return root;
}

/**
 * Every non-repo realm: a flat root -> touched-entity tree (v0 has no deeper
 * containment data for these realms).
 *
 * Leaf `label` routes through `targetDisplayLabel` (mt#3258 SC 3) rather than
 * the raw `entityId` — the raw composite id already carries the realm-prefix
 * scaffolding (`event-adapter.ts`'s "Observed id shapes"), so a leaf under
 * the `unknown` realm previously rendered its `<title>` tooltip as the
 * literal string `unknown:Skill`/`unknown:tasks_children` (the coordinator's
 * live-DOM finding) — the SAME leak the ribbon's `EventTargetLabel` had,
 * just reached via the stage instead of `targetDisplayLabel`'s bare
 * fallback. Reusing that one display function keeps both surfaces
 * consistent and means a future prefix fix only has one call site to touch.
 */
function buildFlatTree(realm: EventRealm, entityIds: readonly string[]): RawNode {
  const root: RawNode = { id: realmRootId(realm), label: realm, entityId: null, children: [] };
  for (const entityId of entityIds) {
    root.children.push({
      id: `${realm}:${entityId}`,
      label: targetDisplayLabel({ realm, id: entityId }),
      entityId,
      children: [],
    });
  }
  return root;
}

function buildRealmTree(realm: EventRealm, entityIds: readonly string[]): RawNode {
  return realm === "repo" ? buildRepoTree(realm, entityIds) : buildFlatTree(realm, entityIds);
}

// ── DOI scoring ───────────────────────────────────────────────────────────

function aprioriImportance(depth: number, config: SessionFilmConfig): number {
  return Math.max(0, config.doi.rootImportance - depth * config.doi.depthDecay);
}

function recencyScore(
  entity: EntityFoldState | undefined,
  nowIso: string,
  config: SessionFilmConfig
): number {
  if (!entity) return 0;
  const now = Date.parse(nowIso);
  const last = Date.parse(entity.lastTouchedAt);
  if (Number.isNaN(now) || Number.isNaN(last)) return 0;
  const elapsedSec = Math.max(0, (now - last) / 1000);
  return Math.exp(-config.doi.recencyDecayPerSecond * elapsedSec);
}

function doiScore(
  depth: number,
  entityId: string | null,
  entities: ReadonlyMap<string, EntityFoldState>,
  nowIso: string,
  config: SessionFilmConfig
): number {
  const entity = entityId ? entities.get(entityId) : undefined;
  return aprioriImportance(depth, config) + recencyScore(entity, nowIso, config);
}

// ── Public layout node shape ──────────────────────────────────────────────

export interface StageLayoutNode {
  id: string;
  realm: EventRealm;
  depth: number;
  label: string;
  /** The underlying touched entity id, or null for a realm root / synthetic path segment. */
  entityId: string | null;
  childCount: number;
  doiScore: number;
  expanded: boolean;
  x: number;
  y: number;
}

export interface StageLayout {
  homeX: number;
  homeY: number;
  nodes: StageLayoutNode[];
}

export interface StageLayoutOptions {
  homeX?: number;
  homeY?: number;
  /** Distance from home to a realm root, world units. */
  rootRadius?: number;
  /** Per-depth-level radial spacing beyond the root, world units. */
  depthSpacing?: number;
}

const DEFAULT_ROOT_RADIUS = 90;
const DEFAULT_DEPTH_SPACING = 70;

/**
 * Compute the full stage layout: every realm root is ALWAYS present
 * (spec: "Every realm tree is present from frame one as its root metanode");
 * nodes beyond the root expand per DOI, capped at the visible-node budget.
 */
export function computeStageLayout(
  world: WorldFoldState,
  nowIso: string,
  config: SessionFilmConfig,
  options: StageLayoutOptions = {}
): StageLayout {
  const homeX = options.homeX ?? 0;
  const homeY = options.homeY ?? 0;
  const rootRadius = options.rootRadius ?? DEFAULT_ROOT_RADIUS;
  const depthSpacing = options.depthSpacing ?? DEFAULT_DEPTH_SPACING;

  // Group touched entities by realm.
  const entityIdsByRealm = new Map<EventRealm, string[]>();
  for (const entity of world.entities.values()) {
    const list = entityIdsByRealm.get(entity.realm) ?? [];
    list.push(entity.id);
    entityIdsByRealm.set(entity.realm, list);
  }

  const allNodes: StageLayoutNode[] = [];

  for (const realm of EVENT_REALMS) {
    // `REALM_BEARINGS_DEG` is typed `Record<EventRealm, number>` (compile-time
    // complete against the schema's realm union — see session-film-config.ts's
    // doc comment), but the `?? 0` here is a defensive SECOND layer in case a
    // version-skewed frontend bundle ever runs against a newer backend schema
    // (a real deploy hazard the type system alone can't close): a missing
    // bearing degrades to a fixed default angle rather than propagating NaN
    // into every downstream world coordinate (reviewer finding, PR #2269 round 1).
    const bearingDeg = REALM_BEARINGS_DEG[realm] ?? 0;
    const bearingRad = (bearingDeg * Math.PI) / 180;

    const entityIds = entityIdsByRealm.get(realm) ?? [];
    const rawRoot = buildRealmTree(realm, entityIds);
    const root: HierarchyNode<RawNode> = hierarchy(rawRoot, (d) => d.children);

    // d3.tree() lays out in a unit square: x in [0,1] is each node's
    // NORMALIZED sibling position (subtree-proportioned — a node's x is a
    // slice of its parent's own allocation), y is depth. size([1, 1]) keeps
    // x normalized regardless of leaf count; the organic-layout section
    // above converts x into an ANGLE within the realm's arc, not a Cartesian
    // offset.
    const layoutTree = d3tree<RawNode>().size([1, 1]);
    const laidOut = layoutTree(root);
    const descendants = laidOut.descendants();
    const leafCount = laidOut.leaves().length || 1;

    // Adaptive-but-capped arc span for this realm's children (see the
    // module doc's "organic child layout" section).
    const arcSpanDeg = Math.min(
      config.layout.arcSpanMaxDeg,
      config.layout.arcSpanBaseDeg + config.layout.arcSpanPerLeafDeg * Math.sqrt(leafCount)
    );
    const arcSpanRad = (arcSpanDeg * Math.PI) / 180;

    // Score every node, decide expansion (DOI threshold OR "on the path to
    // an above-threshold node" — computed as a second pass below).
    const scored = descendants.map((d) => ({
      d,
      score: doiScore(d.depth, d.data.entityId, world.entities, nowIso, config),
    }));

    const aboveThreshold = new Set<HierarchyNode<RawNode>>();
    for (const { d, score } of scored) {
      if (score >= config.doi.expandThreshold) aboveThreshold.add(d);
    }
    // Auto-expand every ancestor of an above-threshold node (root-to-touched-node path).
    const expandedSet = new Set<HierarchyNode<RawNode>>();
    for (const d of aboveThreshold) {
      let cur: HierarchyNode<RawNode> | null = d;
      while (cur) {
        expandedSet.add(cur);
        cur = cur.parent;
      }
    }
    // The realm root itself is ALWAYS present (spec).
    expandedSet.add(root);

    for (const { d, score } of scored) {
      const isRoot = d.depth === 0;
      const expanded = isRoot || expandedSet.has(d);
      if (!expanded) continue; // collapsed nodes render only via their nearest expanded ancestor's child-count badge

      if (isRoot) {
        // The realm root sits EXACTLY on its bearing, no jitter/stagger —
        // it's the fixed compass anchor every child's arc is centered on.
        allNodes.push({
          id: d.data.id,
          realm,
          depth: 0,
          label: REALM_DISPLAY_LABEL[realm] ?? realm,
          entityId: d.data.entityId,
          childCount: d.children?.length ?? 0,
          doiScore: score,
          expanded: true,
          x: homeX + rootRadius * Math.sin(bearingRad),
          y: homeY - rootRadius * Math.cos(bearingRad),
        });
        continue;
      }

      // Normalized sibling position [-0.5, 0.5), subtree-proportioned by
      // d3's tidy-tree — converted to an ANGLE within the realm's arc
      // (organic layout), not a linear Cartesian offset.
      const xNorm = (d.x ?? 0.5) - 0.5;
      const jitter = seededJitter(d.data.id, config);
      const angleRad = bearingRad + xNorm * arcSpanRad + jitter.angleRad;

      // Collision-aware radial stagger: alternate same-parent siblings
      // between two radii by index parity (see module doc's "organic child
      // layout" section) so a dense fan doesn't render as one flat ring.
      const siblingIndex = d.parent?.children?.indexOf(d) ?? 0;
      const stagger = (siblingIndex % 2) * config.layout.siblingStaggerPx;
      const radius = rootRadius + d.depth * depthSpacing + stagger + jitter.radiusPx;

      allNodes.push({
        id: d.data.id,
        realm,
        depth: d.depth,
        label: d.data.label,
        entityId: d.data.entityId,
        childCount: d.children?.length ?? 0,
        doiScore: score,
        expanded: true,
        x: homeX + radius * Math.sin(angleRad),
        y: homeY - radius * Math.cos(angleRad),
      });
    }
  }

  // Visible-node budget: drop lowest-scoring NON-ROOT nodes first when over budget.
  const roots = allNodes.filter((n) => n.depth === 0);
  const nonRoots = allNodes.filter((n) => n.depth > 0).sort((a, b) => b.doiScore - a.doiScore);
  const budget = Math.max(0, config.doi.visibleNodeBudget - roots.length);
  const kept = nonRoots.slice(0, budget);

  return { homeX, homeY, nodes: [...roots, ...kept] };
}
