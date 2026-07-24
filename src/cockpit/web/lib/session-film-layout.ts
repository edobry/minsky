/**
 * Stage layout: collapsed world-forest, DOI-driven expansion, deterministic
 * tidy-tree per realm (mt#3184 — Watchable world Phase 1, spec SC 5).
 *
 * Realm trees root at FIXED compass bearings around the agent's home
 * (`session-film-config.ts`'s `REALM_BEARINGS_DEG`) and lay out radially
 * OUTWARD using `d3-hierarchy`'s deterministic tidy-tree algorithm — no
 * force simulation (spec SC 5 / directive 3). Each realm's raw containment
 * tree is built from the touched entities' synthetic composite ids
 * (`event-schema.ts`'s `EventTarget.id` doc comment): `repo` targets carry
 * real path structure (split on `/`), every other realm is a flat
 * root->entity tree in v0 — the adapter carries no deeper containment for
 * those realms yet (an honest v0 approximation, not an invented hierarchy).
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
import { REALM_BEARINGS_DEG, type SessionFilmConfig } from "./session-film-config";

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

/** Every non-repo realm: a flat root -> touched-entity tree (v0 has no deeper containment data for these realms). */
function buildFlatTree(realm: EventRealm, entityIds: readonly string[]): RawNode {
  const root: RawNode = { id: realmRootId(realm), label: realm, entityId: null, children: [] };
  for (const entityId of entityIds) {
    root.children.push({ id: `${realm}:${entityId}`, label: entityId, entityId, children: [] });
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
  /** Spacing between sibling nodes, world units. */
  siblingSpacing?: number;
}

const DEFAULT_ROOT_RADIUS = 90;
const DEFAULT_DEPTH_SPACING = 70;
const DEFAULT_SIBLING_SPACING = 40;

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
  const siblingSpacing = options.siblingSpacing ?? DEFAULT_SIBLING_SPACING;

  // Group touched entities by realm.
  const entityIdsByRealm = new Map<EventRealm, string[]>();
  for (const entity of world.entities.values()) {
    const list = entityIdsByRealm.get(entity.realm) ?? [];
    list.push(entity.id);
    entityIdsByRealm.set(entity.realm, list);
  }

  const allNodes: StageLayoutNode[] = [];

  for (const realm of EVENT_REALMS) {
    const bearingDeg = REALM_BEARINGS_DEG[realm];
    const angleRad = (bearingDeg * Math.PI) / 180;
    // 0deg = north (up): direction vector points "away from home" along the bearing.
    const dirX = Math.sin(angleRad);
    const dirY = -Math.cos(angleRad);
    const perpX = Math.cos(angleRad);
    const perpY = Math.sin(angleRad);

    const entityIds = entityIdsByRealm.get(realm) ?? [];
    const rawRoot = buildRealmTree(realm, entityIds);
    const root: HierarchyNode<RawNode> = hierarchy(rawRoot, (d) => d.children);

    // d3.tree() lays out in a unit square: x in [0,1] (sibling spread), each
    // node carries its own depth. size([1, 1]) keeps x normalized regardless
    // of leaf count; we scale x ourselves via siblingSpacing below.
    const layoutTree = d3tree<RawNode>().size([1, 1]);
    const laidOut = layoutTree(root);
    const descendants = laidOut.descendants();
    const leafCount = laidOut.leaves().length || 1;

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

      const x = (d.x ?? 0.5) - 0.5; // center around 0
      const radial = isRoot ? rootRadius : rootRadius + d.depth * depthSpacing;
      const spread = x * siblingSpacing * leafCount;

      allNodes.push({
        id: d.data.id,
        realm,
        depth: d.depth,
        label: d.data.label,
        entityId: d.data.entityId,
        childCount: d.children?.length ?? 0,
        doiScore: score,
        expanded: true,
        x: homeX + dirX * radial + perpX * spread,
        y: homeY + dirY * radial + perpY * spread,
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
