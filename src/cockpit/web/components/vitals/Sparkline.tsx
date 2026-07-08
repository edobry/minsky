/**
 * Sparkline — minimal hand-rolled SVG line chart for the /vitals loop cards
 * (mt#2601). No chart dependency, per the task constraint.
 *
 * Renders a polyline across a fixed-width viewBox scaled to the data's own
 * max (so an all-zero series renders a flat baseline rather than a
 * misleading spike-to-nothing). `null` data (rather than an empty array)
 * renders the honest "no data yet" placeholder state — used by the deploy
 * loop card, which has no time-series source until mt#2537 ships deploy.*
 * events.
 */
export interface SparklineProps {
  /** Bucketed values, oldest -> newest. `null` renders an honest placeholder. */
  data: number[] | null;
  colorVar: string;
  width?: number;
  height?: number;
  ariaLabel: string;
  /** Shown under the placeholder dash when `data` is null. */
  placeholderReason?: string;
}

export function Sparkline({
  data,
  colorVar,
  width = 96,
  height = 24,
  ariaLabel,
  placeholderReason,
}: SparklineProps) {
  if (data === null || data.length === 0) {
    return (
      <div
        className="flex flex-col gap-0.5"
        role="img"
        aria-label={`${ariaLabel}: no historical data available`}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <line
            x1={0}
            y1={height / 2}
            x2={width}
            y2={height / 2}
            stroke="oklch(var(--muted-foreground) / 0.4)"
            strokeWidth={1.5}
            strokeDasharray="3 3"
          />
        </svg>
        {placeholderReason && (
          <span className="text-[9px] font-mono text-muted-foreground leading-tight">
            {placeholderReason}
          </span>
        )}
      </div>
    );
  }

  const max = Math.max(1, ...data);
  const stepX = data.length > 1 ? width / (data.length - 1) : width;
  const points = data
    .map((value, i) => {
      const x = i * stepX;
      const y = height - (value / max) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${ariaLabel}: recent trend, ${data.reduce((a, b) => a + b, 0)} total`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={`oklch(var(${colorVar}) / 0.85)`}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
