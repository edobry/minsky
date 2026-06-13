/**
 * GestureEdge — spine edge with an event-driven traveling dot (mt#2377 v2.0).
 *
 * Renders the same smoothstep path as the built-in edge type. When the edge's
 * `data.gestureUntil` is in the future, a dot travels the path via SMIL
 * `animateMotion` — the "material moving through the pipe" gesture, fired
 * only by a real `system_events` row (honest-motion law, mt#2375).
 *
 * Reduced motion: SMIL is not gated by the global CSS reduced-motion rule,
 * so this component checks `prefers-reduced-motion` itself and renders a
 * static stroke-brighten instead of the moving dot.
 */
import { BaseEdge, getSmoothStepPath, Position, type EdgeProps } from "@xyflow/react";

export interface GestureEdgeData {
  /** Epoch ms until which the gesture is active. */
  gestureUntil?: number;
  /** Resolved CSS var for the dot color (e.g. "var(--vsm-s1)"). */
  gestureColorVar?: string;
  [key: string]: unknown;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function GestureEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
  style,
  data,
}: EdgeProps) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const d = (data ?? {}) as GestureEdgeData;
  const active = typeof d.gestureUntil === "number" && d.gestureUntil > Date.now();
  const colorVar = d.gestureColorVar ?? "var(--vsm-s1)";
  const reduced = prefersReducedMotion();

  const effectiveStyle =
    active && reduced
      ? { ...style, stroke: `oklch(${colorVar} / 1)`, strokeWidth: 3.5 }
      : style;

  return (
    <>
      <BaseEdge id={id} path={path} style={effectiveStyle} />
      {active && !reduced && (
        <circle
          r={4}
          fill={`oklch(${colorVar} / 1)`}
          style={{ filter: `drop-shadow(0 0 4px oklch(${colorVar} / 0.8))` }}
          data-testid={`gesture-dot-${id}`}
        >
          <animateMotion dur="1.6s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  );
}
