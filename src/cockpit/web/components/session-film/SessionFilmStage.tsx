/**
 * SessionFilmStage — the A2 stage (mt#3184 — Watchable world Phase 1, spec
 * SC 5 / SC 6).
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
 * @see session-film-layout.ts — the node positions this renders
 * @see session-film-links.ts — entity receipt resolution for node clicks
 */
import { useMemo, useState } from "react";
import type { EventOutcome } from "@minsky/domain/transcripts/event-schema";
import { PanZoomSVG } from "../PanZoomSVG";
import type { StageLayout } from "../../lib/session-film-layout";
import type { AgentFoldState, WorldFoldState } from "../../lib/session-film-fold";
import { guardDocReceiptPath } from "../../lib/session-film-links";
import {
  computeTouchedSetContourPath,
  touchedSetContourColorClass,
} from "../../lib/session-film-contour";
import { DEFAULT_SESSION_FILM_CONFIG, type SessionFilmConfig } from "../../lib/session-film-config";
import { cn } from "../../lib/utils";

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
  /** Tunables (DOI/motion/contour styling) — defaults to DEFAULT_SESSION_FILM_CONFIG. */
  config?: SessionFilmConfig;
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
  layout,
  world,
  reducedMotion,
  onSelectEntity,
  selectedEntityId,
  config = DEFAULT_SESSION_FILM_CONFIG,
  className,
}: SessionFilmStageProps) {
  const agents = useMemo(() => [...world.agents.values()], [world.agents]);

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

  return (
    <PanZoomSVG
      boardWidth={STAGE_BOARD_WIDTH}
      boardHeight={STAGE_BOARD_HEIGHT}
      ariaLabel="Session film stage"
      className={className}
    >
      <g
        transform={`translate(${STAGE_BOARD_WIDTH / 2}, ${STAGE_BOARD_HEIGHT / 2})`}
        data-testid="session-film-stage-scene"
      >
        {/* Realm-tree edges (parent -> child), drawn before nodes so nodes paint over them. */}
        {layout.nodes.map((node) => {
          if (node.depth === 0) return null;
          const parent = layout.nodes.find(
            (n) => n.realm === node.realm && n.depth === node.depth - 1
          );
          if (!parent) return null;
          return (
            <line
              key={`edge-${node.id}`}
              x1={parent.x}
              y1={parent.y}
              x2={node.x}
              y2={node.y}
              className="stroke-border"
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
          const isSelected = node.entityId !== null && node.entityId === selectedEntityId;
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
                onClick={() => node.entityId && onSelectEntity?.(node.entityId)}
                role="button"
                aria-label={`${node.label} (workspace clone)`}
              >
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
                onClick={() => node.entityId && onSelectEntity?.(node.entityId)}
                role="button"
                aria-label={`${node.label} (spawn: ${spawnKindLabel(entity?.raw)})`}
              >
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
              onClick={() => node.entityId && onSelectEntity?.(node.entityId)}
              role={node.entityId ? "button" : undefined}
              aria-label={node.label}
            >
              <circle
                r={isRoot ? ROOT_RADIUS : NODE_RADIUS}
                className={cn(
                  isRoot ? "fill-muted stroke-border" : outcomeClassName(entity?.lastOutcome),
                  isSelected && "stroke-primary stroke-2"
                )}
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

        {/* Avatars — one per actor with fold state; excursions per honest-motion (no idle animation). */}
        {agents.map((agent) => {
          const pos = avatarPosition(agent, world, layout);
          const isPolicy = agent.kind === "policy";
          const isPrincipal = agent.kind === "principal";
          const receiptPath = isPolicy ? guardDocReceiptPath(agent.guardName ?? "unknown") : undefined;
          return (
            <circle
              key={agent.key}
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
              className={cn(
                "cursor-pointer",
                isPolicy ? "fill-warn-red" : isPrincipal ? "fill-signal-cyan" : "fill-iso-pastel",
                !reducedMotion && "transition-[cx,cy] duration-300 ease-out",
                agent.thinking && "animate-status-dot"
              )}
            >
              {isPolicy ? <title>{`Denied by ${agent.guardName ?? "unknown guard"} — ${receiptPath}`}</title> : null}
            </circle>
          );
        })}
      </g>
    </PanZoomSVG>
  );
}
