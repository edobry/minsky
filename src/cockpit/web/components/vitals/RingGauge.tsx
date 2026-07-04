/**
 * RingGauge — compact circular-progress "breath" ring for the /vitals loop
 * cards (mt#2601). Apple-Watch-activity-rings analogy per the task spec: each
 * loop card gets one ring summarizing its current live state at a glance.
 *
 * Hand-rolled SVG (stroke-dasharray arc trick) — no chart dependency, per the
 * task's sparkline/gauge constraint. Independent of PlantFlowPage.tsx's
 * MiniGaugeArc (a different, needle-style gauge scoped to the plant board);
 * this is a fresh, minimal component so /vitals has no file-surface coupling
 * to the plant board's owning sessions.
 *
 * `fraction` is a RENDERING SCALE, not an asserted alarm/health threshold —
 * callers document what maps to 0 and 1 for their metric. See loop card
 * comments for the derivation per metric.
 */
import { cn } from "../../lib/utils";

export interface RingGaugeProps {
  /** 0..1, clamped. What fraction of the ring's arc to fill. */
  fraction: number;
  /** CSS custom property name (without `var()`), e.g. "--vsm-learn". */
  colorVar: string;
  /** Large primary value rendered in the ring's center. */
  valueLabel: string;
  /** Accessible label describing what this ring measures. */
  ariaLabel: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function RingGauge({
  fraction,
  colorVar,
  valueLabel,
  ariaLabel,
  size = 88,
  strokeWidth = 8,
  className,
}: RingGaugeProps) {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped);
  const center = size / 2;

  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      role="img"
      aria-label={ariaLabel}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="oklch(var(--border) / 1)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={`oklch(var(${colorVar}) / 0.9)`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="font-mono text-lg font-semibold text-foreground tabular-nums">
          {valueLabel}
        </span>
      </div>
    </div>
  );
}
