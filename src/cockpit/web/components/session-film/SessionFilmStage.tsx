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
import { useMemo } from "react";
import type { EventOutcome } from "@minsky/domain/transcripts/event-schema";
import { PanZoomSVG } from "../PanZoomSVG";
import type { StageLayout } from "../../lib/session-film-layout";
import type { AgentFoldState, WorldFoldState } from "../../lib/session-film-fold";
import { guardDocReceiptPath } from "../../lib/session-film-links";
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
  className?: string;
}

function outcomeClassName(outcome: EventOutcome | undefined): string {
  if (outcome === undefined) return "fill-warn-amber"; // unpaired = in-flight (never silently "ok")
  if (outcome === "error") return "fill-warn-red";
  if (outcome === "denied") return "fill-warn-red";
  return "fill-signal-cyan";
}

/** World position of an agent's avatar: its current excursion target if visible, else home. */
function avatarPosition(
  agent: AgentFoldState,
  layout: StageLayout
): { x: number; y: number; atHome: boolean } {
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
  className,
}: SessionFilmStageProps) {
  const agents = useMemo(() => [...world.agents.values()], [world.agents]);

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

        {/* Realm/entity nodes */}
        {layout.nodes.map((node) => {
          const entity = node.entityId ? world.entities.get(node.entityId) : undefined;
          const isRoot = node.depth === 0;
          const isSelected = node.entityId !== null && node.entityId === selectedEntityId;
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

        {/* Avatars — one per actor with fold state; excursions per honest-motion (no idle animation). */}
        {agents.map((agent) => {
          const pos = avatarPosition(agent, layout);
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
              className={cn(
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
