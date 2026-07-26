/**
 * SessionFilmStage — the A2 stage (mt#3184 — Watchable world Phase 1, spec
 * SC 5 / SC 6; aliveness pass mt#3226 SC 4).
 *
 * SVG scene: the collapsed world-forest (via `computeStageLayout`), avatar
 * figures making excursions from home to their current target, outcome
 * physics per node (in-flight/ok/error/denied), and a policy-actor marker
 * for guard denials. Pan/zoom is its OWN input channel (`PanZoomSVG`,
 * mt#2380) — page scroll stays reserved for the playhead (spec SC 6).
 *
 * Honest motion (plant-board canon, directive 3): every position change is
 * driven by the fold's current world state, never a decorative idle
 * animation. `reducedMotion` degrades the avatar's excursion tween to an
 * instant discrete position change (spec AT 7) — implemented by NOT
 * applying the CSS transition class at all under reduced motion, not by
 * zeroing a duration (the acceptance test asserts "no tween classes
 * present").
 *
 * Per the brand system's iso.pastel reservation ("agent ghost/companion
 * overlays"), the agent avatar renders in `fill-iso-pastel`; the principal's
 * own figure uses the signal-cyan accent to stay visually distinct.
 *
 * ## Aliveness pass (mt#3226 SC 4)
 *
 * Operator's summary judgment on v1: "it doesn't feel alive... I don't get
 * the sense of excitement I got from [Gource]." Four mechanics, all gated
 * behind the SAME `!reducedMotion` flag that already gates the excursion
 * tween above (AT 5: "renders no ambient animation classes/elements" under
 * reduced motion — a coarse `data-ambient` marker on the scene root plus
 * per-affordance absence, not merely a zeroed CSS duration):
 *
 *   - **Bloom/glow** — one shared SVG `<filter>` (feGaussianBlur), applied
 *     to nodes/beams/avatar with brightness/blur-radius driven by
 *     `session-film-aliveness.ts`'s `computeGlowBrightness` — a CONTINUOUS
 *     decay of wall-clock time since last touch (via `useAmbientClock`'s
 *     ticking "now"), so the scene visibly cools between events instead of
 *     snapping. This ticking clock reads already-known `lastTouchedAt`
 *     values; it never mutates fold/world state or invents an event.
 *   - **Arrival physics** — a newly-materialized node gets the
 *     `session-film-arrival-settle` class (index.css) for one settle
 *     duration (spring overshoot + damp), tracked via a "seen ids" ref
 *     compared each render; its connecting edge eases in alongside it.
 *   - **Camera life** — `PanZoomSVG`'s `ambientDrift` (mt#3226) drives slow
 *     viewBox drift/zoom breathing, paused the instant the user pans/zooms.
 *   - **Avatar aliveness** — the SAME iso-pastel-filled avatar gets the
 *     bloom filter plus a subtle idle-float class (`session-film-avatar-float`).
 *
 * Design-decision record (verbatim — required in code AND the PR body): the
 * plant board's honest-motion law is deliberately carved out for the film's
 * AMBIENT register (camera drift, idle float, decay breathing) — the film
 * is a narrative surface, not a status instrument; ambience must NEVER be
 * event-mimicking (no fake beams, no fake node activity). Event-driven
 * motion (excursions, beams, arrivals) remains strictly honest. Operator
 * approved this direction 2026-07-25 by requesting it.
 *
 * ## Beam-on-every-action (mt#3231 SC 7)
 *
 * v1.1 only fired a beam for a genuine PARALLEL batch (`fanOutTargetIds`
 * below). A singleton (non-batch) action just moved the avatar with no
 * pulse — the operator's exact v1.2 finding: "it goes somewhere and
 * something happens but it's not clear it's doing stuff." Every actor whose
 * CURRENT folded action resolves to a target now draws ONE beam with
 * "outcome physics" (`session-film-beams.ts`): pull for read, push for
 * write/create, fan for search, a louder push for delete, and bounce/policy
 * overrides for error/denied outcomes regardless of verb. This is honest,
 * event-driven motion (not the ambient register) — the beam exists because
 * the fold's CURRENT state has a real `lastVerb`/`currentTargetId`, not a
 * decorative loop.
 *
 * ## Living layout (mt#3231 SC 4)
 *
 * `layout` (the `computeStageLayout` prop) is immediately wrapped by
 * `useSessionFilmForceLayout` into `layout` (shadowed) — a LIVE d3-force
 * simulation warm-started from the same tidy-tree positions. Every
 * reference to `layout` below therefore already reads live, gently-
 * drifting positions; nothing downstream needed to change since nodes stay
 * keyed by the same `id`/`entityId`. See `session-film-force-layout.ts`
 * for the honest-motion carve-out record for this pass specifically.
 *
 * @see session-film-layout.ts — the STATIC tidy-tree this warm-starts from
 * @see session-film-force-layout.ts — the live simulation + its honest-motion carve-out record
 * @see ../hooks/useSessionFilmForceLayout.ts — the React tick-loop wiring
 * @see session-film-links.ts — entity receipt resolution for node clicks
 * @see session-film-aliveness.ts — glow-brightness math + the full design-decision record
 * @see session-film-beams.ts — beam-kind/direction/styling logic for the beam-on-every-action pass
 * @see PanZoomSVG.tsx — ambient camera drift
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { EventOutcome } from "@minsky/domain/transcripts/event-schema";
import { PanZoomSVG } from "../PanZoomSVG";
import type { StageLayout } from "../../lib/session-film-layout";
import type { AgentFoldState, EntityFoldState, WorldFoldState } from "../../lib/session-film-fold";
import { guardDocReceiptPath } from "../../lib/session-film-links";
import { parseRoutableTarget } from "../../lib/session-film-target-ref";
import { EntityRef } from "../EntityRef";
import {
  computeTouchedSetContourPath,
  touchedSetContourColorClass,
} from "../../lib/session-film-contour";
import { DEFAULT_SESSION_FILM_CONFIG, type SessionFilmConfig } from "../../lib/session-film-config";
import { bloomOpacity, bloomStdDeviation, computeGlowBrightness } from "../../lib/session-film-aliveness";
import {
  beamClassName,
  beamDashArray,
  beamEndpoints,
  beamKindForAgentState,
  beamStrokeWidth,
} from "../../lib/session-film-beams";
import { useAmbientClock } from "../../hooks/useAmbientClock";
import { useSessionFilmForceLayout } from "../../hooks/useSessionFilmForceLayout";
import { cn } from "../../lib/utils";

/** Shared bloom-filter id — one filter definition, referenced by every glowing element. */
const BLOOM_FILTER_ID = "session-film-bloom";

export const STAGE_BOARD_WIDTH = 900;
export const STAGE_BOARD_HEIGHT = 700;
const NODE_RADIUS = 5;
const ROOT_RADIUS = 9;
const AVATAR_RADIUS = 8;

export interface SessionFilmStageProps {
  layout: StageLayout;
  world: WorldFoldState;
  reducedMotion: boolean;
  onSelectEntity?: (entityId: string) => void;
  selectedEntityId?: string | null;
  /** Tunables (DOI/motion/contour styling/aliveness) — defaults to DEFAULT_SESSION_FILM_CONFIG. */
  config?: SessionFilmConfig;
  /**
   * The fold's current playhead moment (mt#3226 SC 4) — the STATIC fallback
   * `computeGlowBrightness` uses under reduced motion (no ticking clock, per
   * the ambient-register carve-out). Optional: a caller that doesn't pass it
   * (existing tests) falls back to a one-time `new Date()` snapshot, which
   * only matters when ambience is enabled anyway.
   */
  nowIso?: string;
  className?: string;
}

function outcomeClassName(outcome: EventOutcome | undefined): string {
  if (outcome === undefined) return "fill-warn-amber"; // unpaired = in-flight (never silently "ok")
  if (outcome === "error") return "fill-warn-red";
  if (outcome === "denied") return "fill-warn-red";
  return "fill-signal-cyan";
}

/** Stroke-variant of {@link outcomeClassName}, for bordered (not filled) node treatments. */
function outcomeStrokeClassName(outcome: EventOutcome | undefined): string {
  return outcomeClassName(outcome).replace("fill-", "stroke-");
}

/**
 * Best-effort subagent kind for a spawn bud's label (spec SC 5: "a spawn
 * event buds a small static avatar-badge (kind/outcome)"). Mirrors
 * `event-adapter.ts`'s `agentSpawnTargetExtractor`, which sets
 * `target.raw` to the RAW tool-call input (containing `subagent_type` for
 * the `Agent`/dispatch tool) — read defensively since `raw`'s shape is
 * tool-specific and not itself part of the versioned schema contract.
 */
function spawnKindLabel(raw: unknown): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const kind = rec["subagent_type"];
    if (typeof kind === "string" && kind.length > 0) return kind;
  }
  return "agent";
}

/**
 * Hover-tooltip text for a leaf entity node (mt#3231 SC 6 / AT 6): an SVG
 * `<title>` at minimum (the spec's stated floor) — the native browser
 * tooltip that appears on hover. Only realm ROOTS carried a visible
 * `<text>` label in v1.1; leaves carried nothing but a screen-reader
 * `aria-label`, which sighted mouse-hover users never see. Includes the
 * node's realm + entity id + last verb/outcome so the tooltip is a genuine
 * receipt, not just an echo of the already-visible label.
 */
function nodeTooltipText(label: string, realm: string, entity: EntityFoldState | undefined): string {
  if (!entity) return label;
  const outcome = entity.lastOutcome ?? "in-flight";
  return `${label} (${realm}) — ${entity.lastVerb} · ${outcome}`;
}

/**
 * Fan-out targets for the CURRENT row, when it was a genuine parallel batch
 * (spec SC 5/SC 10, AT 1's stage half): "a parallel batch renders beams to
 * ALL targets simultaneously with the avatar at home — never a sequential
 * walk, never last-target-only." Returns `null` when the last-folded row
 * wasn't a parallel batch for this agent, or fanned out to only one target
 * (a single target degenerates to the ordinary excursion below).
 */
function fanOutTargetIds(agent: AgentFoldState, world: WorldFoldState): string[] | null {
  if (!world.lastRowIsParallelBatch) return null;
  const rowTargets = world.lastRowTargetsByActor.get(agent.key);
  if (!rowTargets) return null;
  const distinct = [...new Set(rowTargets)];
  return distinct.length > 1 ? distinct : null;
}

/**
 * World position of an agent's avatar: home during a parallel-batch fan-out
 * (the avatar never walks to any one target when a batch fired
 * simultaneously — see {@link fanOutTargetIds}), else its current single
 * excursion target if visible, else home.
 */
function avatarPosition(
  agent: AgentFoldState,
  world: WorldFoldState,
  layout: StageLayout
): { x: number; y: number; atHome: boolean } {
  if (fanOutTargetIds(agent, world)) {
    return { x: layout.homeX, y: layout.homeY, atHome: true };
  }
  if (agent.currentTargetId) {
    const targetNode = layout.nodes.find((n) => n.entityId === agent.currentTargetId);
    if (targetNode) return { x: targetNode.x, y: targetNode.y, atHome: false };
  }
  return { x: layout.homeX, y: layout.homeY, atHome: true };
}

export function SessionFilmStage({
  layout: staticLayout,
  world,
  reducedMotion,
  onSelectEntity,
  selectedEntityId,
  config = DEFAULT_SESSION_FILM_CONFIG,
  nowIso,
  className,
}: SessionFilmStageProps) {
  // Living layout (mt#3231 SC 4): every downstream reference to `layout`
  // below (edges, beams, avatar excursions, node clicks, the contour) reads
  // LIVE force-simulated positions instead of the compute-once tidy-tree —
  // nodes are still keyed by the SAME `id`/`entityId`, so nothing else in
  // this component needs to change.
  const layout = useSessionFilmForceLayout(staticLayout, config, reducedMotion);
  const agents = useMemo(() => [...world.agents.values()], [world.agents]);

  // Working click -> visible detail affordance (mt#3231 SC 6 / AT 6):
  // `onSelectEntity` already fired in v1.1 with nothing downstream
  // consuming it (the real bug — not the click handler, the missing
  // affordance). Tracks its OWN selection as a fallback so this component
  // renders a real detail panel even when the parent page doesn't (yet)
  // control `selectedEntityId` — a controlling parent's prop still wins.
  const [internalSelectedEntityId, setInternalSelectedEntityId] = useState<string | null>(null);
  const effectiveSelectedEntityId = selectedEntityId ?? internalSelectedEntityId;
  const selectEntity = (entityId: string) => {
    onSelectEntity?.(entityId);
    setInternalSelectedEntityId(entityId);
  };
  const selectedEntity = effectiveSelectedEntityId ? world.entities.get(effectiveSelectedEntityId) : undefined;
  const selectedRoutable = selectedEntity ? parseRoutableTarget(selectedEntity) : null;

  // Touched-set contour visibility (spec SC 7 / AT 5): "off by default;"
  // hover shows transiently, click PINS it open until clicked again — so a
  // reviewer can move the mouse to inspect the contour without losing it.
  const [hoveredAgentKey, setHoveredAgentKey] = useState<string | null>(null);
  const [pinnedAgentKey, setPinnedAgentKey] = useState<string | null>(null);
  const activeContourKey = hoveredAgentKey ?? pinnedAgentKey;

  const repoRoot = useMemo(
    () => layout.nodes.find((n) => n.realm === "repo" && n.depth === 0) ?? null,
    [layout.nodes]
  );

  // ── Aliveness pass (mt#3226 SC 4) — see module doc for the full design ──
  const fallbackNowRef = useRef<string>(new Date().toISOString());
  const staticNowIso = nowIso ?? fallbackNowRef.current;
  // Continuous decay brightness (glow): the ONE ticking clock in this
  // component, disabled entirely under reduced motion (falls back to the
  // static playhead moment — no ticking, matching "no ambient animation").
  const ambientNowIso = useAmbientClock(!reducedMotion, config.aliveness.glowTickIntervalMs, staticNowIso);

  // Arrival physics: a node id newly present in `layout.nodes` (vs. the
  // PREVIOUS render) gets the spring-settle treatment for one settle
  // duration. Tracked via a ref (survives renders without re-triggering
  // itself) — the diff and the timer both live in an effect so a discarded
  // render (StrictMode double-invoke) can't corrupt the "seen" set.
  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  const [justArrivedIds, setJustArrivedIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (reducedMotion) {
      prevNodeIdsRef.current = new Set(layout.nodes.map((n) => n.id));
      setJustArrivedIds(new Set());
      return;
    }
    const currentIds = new Set(layout.nodes.map((n) => n.id));
    const newlyArrived = new Set<string>();
    for (const id of currentIds) {
      if (!prevNodeIdsRef.current.has(id)) newlyArrived.add(id);
    }
    prevNodeIdsRef.current = currentIds;
    if (newlyArrived.size === 0) return;
    setJustArrivedIds(newlyArrived);
    const timeout = setTimeout(() => setJustArrivedIds(new Set()), config.aliveness.arrivalSettleMs);
    return () => clearTimeout(timeout);
  }, [layout.nodes, reducedMotion, config.aliveness.arrivalSettleMs]);

  const arrivalCssVars = {
    "--arrival-overshoot": config.aliveness.arrivalOvershootScale,
    "--arrival-duration": `${config.aliveness.arrivalSettleMs}ms`,
  } as React.CSSProperties;
  const avatarFloatCssVars = {
    "--float-amplitude": `${config.aliveness.avatarFloatAmplitudePx}px`,
    "--float-period": `${config.aliveness.avatarFloatPeriodMs}ms`,
  } as React.CSSProperties;

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)}>
    <PanZoomSVG
      boardWidth={STAGE_BOARD_WIDTH}
      boardHeight={STAGE_BOARD_HEIGHT}
      ariaLabel="Session film stage"
      ambientDrift={{
        enabled: !reducedMotion,
        amplitudePx: config.aliveness.driftAmplitudePx,
        periodMs: config.aliveness.driftPeriodMs,
      }}
      className="flex-1"
    >
      <g
        transform={`translate(${STAGE_BOARD_WIDTH / 2}, ${STAGE_BOARD_HEIGHT / 2})`}
        data-testid="session-film-stage-scene"
        data-ambient={!reducedMotion ? "true" : undefined}
      >
        {/* Bloom/glow filter (mt#3226 SC 4): ONE shared, FIXED-blur filter —
            "activity brightens, idleness dims" is expressed by modulating
            each glow-underlay circle's own RADIUS + OPACITY (cheap, ordinary
            SVG/CSS properties, correct at ~80 nodes) rather than minting a
            per-node filter with a continuously-varying stdDeviation (a
            distinct SVG filter per element is comparatively expensive —
            the nearest feasible treatment per the task's SVG-perf carve-out;
            see the PR body). */}
        {!reducedMotion ? (
          <defs>
            <filter id={BLOOM_FILTER_ID} x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation={config.aliveness.bloomBlurStdDeviation} result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
        ) : null}

        {/* Glow-underlay layer (mt#3226 SC 4): drawn BEFORE every other pass
            so the halo sits fully behind the crisp solid node it belongs to
            — the node's own fill/legibility never dims, only its halo does. */}
        {!reducedMotion
          ? layout.nodes.map((node) => {
              if (!node.entityId) return null; // roots/synthetic path segments don't glow
              const entity = world.entities.get(node.entityId);
              if (!entity) return null;
              const brightness = computeGlowBrightness(entity.lastTouchedAt, ambientNowIso, config);
              const glowRadius = bloomStdDeviation(brightness, config) + NODE_RADIUS;
              return (
                <circle
                  key={`glow-${node.id}`}
                  data-testid={`session-film-glow-${node.id}`}
                  cx={node.x}
                  cy={node.y}
                  r={glowRadius}
                  filter={`url(#${BLOOM_FILTER_ID})`}
                  className={outcomeClassName(entity.lastOutcome)}
                  style={{ opacity: bloomOpacity(brightness) }}
                />
              );
            })
          : null}
        {/* Realm-tree edges (parent -> child), drawn before nodes so nodes paint over them. */}
        {layout.nodes.map((node) => {
          if (node.depth === 0) return null;
          const parent = layout.nodes.find(
            (n) => n.realm === node.realm && n.depth === node.depth - 1
          );
          if (!parent) return null;
          // Arrival physics (mt#3226 SC 4): an edge to a JUST-arrived node
          // eases in alongside it, instead of popping into place.
          const isNewEdge = !reducedMotion && justArrivedIds.has(node.id);
          return (
            <line
              key={`edge-${node.id}`}
              x1={parent.x}
              y1={parent.y}
              x2={node.x}
              y2={node.y}
              className={cn("stroke-border", isNewEdge && "session-film-edge-ease-in")}
              style={isNewEdge ? arrivalCssVars : undefined}
              strokeWidth={1}
            />
          );
        })}

        {/* Clone-of arcs (spec SC 5): drawn BEFORE nodes so the dashed arc
            back to the repo root sits behind the sub-territory it connects. */}
        {layout.nodes.map((node) => {
          const entity = node.entityId ? world.entities.get(node.entityId) : undefined;
          if (entity?.lastVerb !== "clone" || !repoRoot) return null;
          return (
            <line
              key={`clone-arc-${node.id}`}
              data-testid={`session-film-clone-arc-${node.id}`}
              aria-label="clone-of"
              x1={repoRoot.x}
              y1={repoRoot.y}
              x2={node.x}
              y2={node.y}
              className="stroke-signal-cyan"
              strokeWidth={1}
              strokeDasharray="2,3"
              strokeOpacity={0.6}
            >
              <title>clone-of</title>
            </line>
          );
        })}

        {/* Realm/entity nodes */}
        {layout.nodes.map((node) => {
          const entity = node.entityId ? world.entities.get(node.entityId) : undefined;
          const isRoot = node.depth === 0;
          const isSelected = node.entityId !== null && node.entityId === effectiveSelectedEntityId;
          const isSpawnBud = entity?.lastVerb === "spawn";
          const isCloneTerritory = entity?.lastVerb === "clone";

          // Workspace-clone sub-territory (spec SC 5): a bordered region
          // with a compressed file-tree glyph, distinct from a plain node —
          // the clone-of arc back to the repo root is drawn in the pass
          // above. Static rendering only (single-transcript scope, per the
          // build-order guidance) — no live per-file contents.
          if (isCloneTerritory) {
            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                data-testid={`session-film-node-${node.id}`}
                data-entity-id={node.entityId ?? undefined}
                data-realm={node.realm}
                data-clone-territory="true"
                className="cursor-pointer"
                onClick={() => node.entityId && selectEntity(node.entityId)}
                role="button"
                aria-label={`${node.label} (workspace clone)`}
              >
                <title>{nodeTooltipText(node.label, node.realm, entity)}</title>
                <rect
                  data-testid="session-film-clone-border"
                  x={-14}
                  y={-10}
                  width={28}
                  height={20}
                  rx={3}
                  className={cn("fill-card", outcomeStrokeClassName(entity?.lastOutcome))}
                  strokeWidth={1.25}
                  strokeDasharray="3,2"
                />
                <g
                  data-testid="session-film-clone-tree-glyph"
                  className="stroke-muted-foreground"
                  strokeWidth={0.75}
                >
                  <line x1={-8} y1={-4} x2={8} y2={-4} />
                  <line x1={-6} y1={0} x2={6} y2={0} />
                  <line x1={-4} y1={4} x2={4} y2={4} />
                </g>
              </g>
            );
          }

          // Subagent spawn bud (spec SC 5): a small static avatar-badge
          // (kind + outcome color), not a plain circle — buds near its
          // parent on the agents bearing by construction (the tidy-tree
          // layout places it as a child of the agents realm root).
          if (isSpawnBud) {
            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                data-testid={`session-film-node-${node.id}`}
                data-entity-id={node.entityId ?? undefined}
                data-realm={node.realm}
                data-spawn-bud="true"
                data-spawn-kind={spawnKindLabel(entity?.raw)}
                className="cursor-pointer"
                onClick={() => node.entityId && selectEntity(node.entityId)}
                role="button"
                aria-label={`${node.label} (spawn: ${spawnKindLabel(entity?.raw)})`}
              >
                <title>{nodeTooltipText(node.label, node.realm, entity)}</title>
                <rect
                  x={-5}
                  y={-5}
                  width={10}
                  height={10}
                  rx={2}
                  className={cn(outcomeClassName(entity?.lastOutcome), isSelected && "stroke-primary stroke-2")}
                />
                <text
                  y={16}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[8px] font-mono"
                >
                  {spawnKindLabel(entity?.raw)}
                </text>
              </g>
            );
          }

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              data-testid={`session-film-node-${node.id}`}
              data-entity-id={node.entityId ?? undefined}
              data-realm={node.realm}
              data-depth={node.depth}
              className="cursor-pointer"
              onClick={() => node.entityId && selectEntity(node.entityId)}
              role={node.entityId ? "button" : undefined}
              aria-label={node.label}
            >
              <title>
                {isRoot
                  ? `${node.label} (${node.childCount} touched)`
                  : nodeTooltipText(node.label, node.realm, entity)}
              </title>
              <circle
                r={isRoot ? ROOT_RADIUS : NODE_RADIUS}
                className={cn(
                  isRoot ? "fill-muted stroke-border" : outcomeClassName(entity?.lastOutcome),
                  isSelected && "stroke-primary stroke-2",
                  !reducedMotion && justArrivedIds.has(node.id) && "session-film-arrival-settle"
                )}
                style={!reducedMotion && justArrivedIds.has(node.id) ? arrivalCssVars : undefined}
                strokeWidth={isRoot ? 1.5 : undefined}
              />
              {isRoot && node.childCount > 0 ? (
                <text
                  y={ROOT_RADIUS + 12}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[9px] font-mono uppercase"
                >
                  {node.label} ({node.childCount})
                </text>
              ) : null}
            </g>
          );
        })}

        {/* Fan-out beams (spec SC 5/SC 10): a parallel batch fires beams to
            ALL its targets simultaneously, drawn BEFORE the avatars so the
            avatar circle paints over the beam origin at home. */}
        {agents.map((agent) => {
          const fanTargets = fanOutTargetIds(agent, world);
          if (!fanTargets) return null;
          return fanTargets.map((targetId) => {
            const targetNode = layout.nodes.find((n) => n.entityId === targetId);
            if (!targetNode) return null; // target collapsed out of the DOI budget this frame — nothing to beam to
            return (
              <line
                key={`fanout-${agent.key}-${targetId}`}
                data-testid={`session-film-beam-${agent.key}-${targetId}`}
                data-fan-out="true"
                x1={layout.homeX}
                y1={layout.homeY}
                x2={targetNode.x}
                y2={targetNode.y}
                className="stroke-signal-cyan"
                strokeWidth={1.5}
                strokeOpacity={0.7}
              />
            );
          });
        })}

        {/* Singleton action beams (mt#3231 SC 7 / AT 7): "a beam on EVERY
            action, not just batches" — v1.1 only beamed a genuine parallel
            fan-out; a lone action just moved the avatar with no pulse
            (operator: "it's not clear it's doing stuff"). One beam per
            agent whose CURRENT folded action has outcome physics
            (`session-film-beams.ts`) and isn't already covered by the
            fan-out beams above (a fanned-out agent's beams are already
            drawn — never double-beam the same actor). */}
        {agents.map((agent) => {
          if (fanOutTargetIds(agent, world)) return null; // fan-out beams above already cover this actor
          const kind = beamKindForAgentState(agent);
          if (!kind) return null;
          const targetNode = agent.currentTargetId
            ? layout.nodes.find((n) => n.entityId === agent.currentTargetId)
            : undefined;
          if (!targetNode) return null; // target collapsed out of the DOI budget this frame
          const { x1, y1, x2, y2 } = beamEndpoints(
            kind,
            { x: layout.homeX, y: layout.homeY },
            { x: targetNode.x, y: targetNode.y }
          );
          const dash = beamDashArray(kind);
          return (
            <line
              key={`beam-${agent.key}`}
              data-testid={`session-film-beam-${agent.key}-${agent.currentTargetId}`}
              data-beam-kind={kind}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              className={cn(
                beamClassName(kind),
                !reducedMotion && "session-film-beam-pulse",
                !reducedMotion && kind === "bounce" && "session-film-beam-bounce"
              )}
              style={
                !reducedMotion
                  ? ({
                      "--beam-duration": `${config.motion.beamDurationMs}ms`,
                      "--beam-dash": dash ?? "5 4",
                    } as React.CSSProperties)
                  : undefined
              }
              strokeWidth={beamStrokeWidth(kind)}
              strokeDasharray={dash}
              strokeOpacity={0.75}
            />
          );
        })}

        {/* Touched-set contour (spec SC 7 / AT 5): off by default, drawn on
            avatar hover/click, crosses realm trees freely. */}
        {agents.map((agent) => {
          if (activeContourKey !== agent.key) return null;
          const path = computeTouchedSetContourPath(agent, layout, config);
          if (!path) return null;
          return (
            <path
              key={`contour-${agent.key}`}
              data-testid={`session-film-contour-${agent.key}`}
              aria-label="touched"
              d={path}
              className={cn("pointer-events-none", touchedSetContourColorClass(agent))}
              style={{ fillOpacity: config.contour.opacity }}
              strokeWidth={config.contour.strokeWidth}
            >
              <title>touched</title>
            </path>
          );
        })}

        {/* Avatars — one per actor with fold state. Excursions (cx/cy) are
            honest-motion (fold-driven, spec AT 7); the glow halo + idle
            float below are the AMBIENT register (mt#3226 SC 4 — "the avatar
            is the most alive object"), gated behind !reducedMotion. Avatar
            glow brightness derives from the `thinking` flag (a binary
            hot/baseline signal already on AgentFoldState) rather than
            continuous recency-decay like world nodes: AgentFoldState
            doesn't carry a last-activity timestamp, and extending the fold
            schema for it is out of this round's scope (nearest feasible
            treatment — see the PR body). */}
        {agents.map((agent) => {
          const pos = avatarPosition(agent, world, layout);
          const isPolicy = agent.kind === "policy";
          const isPrincipal = agent.kind === "principal";
          const receiptPath = isPolicy ? guardDocReceiptPath(agent.guardName ?? "unknown") : undefined;
          const fillClass = isPolicy ? "fill-warn-red" : isPrincipal ? "fill-signal-cyan" : "fill-iso-pastel";
          const avatarBrightness = agent.thinking ? 1 : 0.6;
          return (
            <g key={agent.key}>
              {!reducedMotion ? (
                <circle
                  data-testid={`session-film-avatar-glow-${agent.key}`}
                  cx={pos.x}
                  cy={pos.y}
                  r={bloomStdDeviation(avatarBrightness, config) + AVATAR_RADIUS}
                  filter={`url(#${BLOOM_FILTER_ID})`}
                  className={cn(fillClass, "pointer-events-none")}
                  style={{ opacity: bloomOpacity(avatarBrightness) }}
                />
              ) : null}
              <circle
                data-testid={`session-film-avatar-${agent.key}`}
                data-at-home={pos.atHome ? "true" : undefined}
                data-thinking={agent.thinking ? "true" : undefined}
                data-receipt-path={receiptPath}
                cx={pos.x}
                cy={pos.y}
                r={AVATAR_RADIUS}
                onMouseEnter={() => setHoveredAgentKey(agent.key)}
                onMouseLeave={() => setHoveredAgentKey((k) => (k === agent.key ? null : k))}
                onClick={() => setPinnedAgentKey((k) => (k === agent.key ? null : agent.key))}
                style={!reducedMotion ? avatarFloatCssVars : undefined}
                className={cn(
                  "cursor-pointer",
                  fillClass,
                  // Pronounced excursion arcs (mt#3226 SC 4): a spring/
                  // overshoot easing + longer duration than the plain
                  // ease-out every other node uses — the avatar's arrival
                  // reads as WEIGHT settling, not a linear glide.
                  !reducedMotion &&
                    "transition-[cx,cy] duration-500 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]",
                  !reducedMotion && "session-film-avatar-float",
                  agent.thinking && "animate-status-dot"
                )}
              >
                {isPolicy ? (
                  <title>{`Denied by ${agent.guardName ?? "unknown guard"} — ${receiptPath}`}</title>
                ) : null}
              </circle>
            </g>
          );
        })}
      </g>
    </PanZoomSVG>
      {/* Working click -> visible detail affordance (mt#3231 SC 6 / AT 6):
          `onSelectEntity` fired in v1.1 with nothing downstream — this panel
          IS the consumer. Rendered as an HTML overlay (not SVG) sibling to
          PanZoomSVG so it stays screen-fixed regardless of pan/zoom. */}
      {selectedEntity ? (
        <div
          data-testid="session-film-entity-detail-panel"
          className="absolute bottom-2 left-2 z-10 max-w-xs rounded border border-border bg-card p-2 text-xs shadow-sm"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate font-mono font-semibold text-foreground">{selectedEntity.id}</span>
            <button
              type="button"
              aria-label="Close entity detail"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setInternalSelectedEntityId(null)}
            >
              ×
            </button>
          </div>
          <div className="text-muted-foreground">
            {selectedEntity.realm} · {selectedEntity.lastVerb} ·{" "}
            {selectedEntity.lastOutcome ?? "in-flight"}
          </div>
          {selectedRoutable ? (
            <div className="mt-1">
              <EntityRef type={selectedRoutable.type} id={selectedRoutable.id} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
