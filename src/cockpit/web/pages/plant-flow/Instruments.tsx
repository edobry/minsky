/**
 * Instrument/gauge primitives shared by PlantFlowPage's organ node panels
 * (mt#2598 split — extracted verbatim from PlantFlowPage.tsx's "Reusable
 * sub-components used inside node panels" section).
 *
 * - MiniGaugeArc: compact SVG gauge arc with needle + setpoint tick, used by
 *   the S3 Management node's alarm gauges (see plant-flow/PolicyNodes.tsx).
 * - VesselTank: vertical fill-level tank glyph ported from the retired SVG
 *   schematic board (mt#2466 item 3), used by the READY and REVIEW S1 nodes
 *   (see plant-flow/StageNodes.tsx).
 */

/** Compact mini gauge arc (SVG) — used inside the S3 node. */
export function MiniGaugeArc({
  label,
  sublabel,
  needleFraction,
  setpointFraction,
  valueLabel,
}: {
  label: string;
  sublabel: string;
  needleFraction: number;
  setpointFraction: number;
  /** Real reading behind the needle, or "—" for an honest gap (mt#2590). */
  valueLabel?: string;
}) {
  const size = 64;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const r = 22;
  const startAngle = -150;
  const endAngle = 150;
  const totalRange = endAngle - startAngle;

  function pt(deg: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + Math.cos(rad) * r, y: cy + Math.sin(rad) * r };
  }

  const arcStart = pt(startAngle);
  const arcEnd = pt(endAngle);
  const needleDeg = startAngle + needleFraction * totalRange;
  const setpointDeg = startAngle + setpointFraction * totalRange;
  const needlePt = pt(needleDeg);
  const setptInner = pt(setpointDeg);
  const setptOuter = {
    x: cx + Math.cos(((setpointDeg - 90) * Math.PI) / 180) * (r + 7),
    y: cy + Math.sin(((setpointDeg - 90) * Math.PI) / 180) * (r + 7),
  };

  return (
    <figure className="flex flex-col items-center gap-0.5" aria-label={`Gauge: ${label}`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        className="overflow-visible"
      >
        <path
          d={`M${arcStart.x} ${arcStart.y} A${r} ${r} 0 1 1 ${arcEnd.x} ${arcEnd.y}`}
          fill="none"
          stroke="oklch(var(--border) / 1)"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <line
          x1={setptInner.x}
          y1={setptInner.y}
          x2={setptOuter.x}
          y2={setptOuter.y}
          stroke="oklch(var(--warn-red) / 0.9)"
          strokeWidth="2"
        />
        <line
          x1={cx}
          y1={cy}
          x2={needlePt.x}
          y2={needlePt.y}
          stroke="oklch(var(--foreground) / 0.85)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r="2" fill="oklch(var(--foreground) / 0.7)" />
      </svg>
      <figcaption className="text-center">
        <div className="text-[9px] font-mono text-foreground/80 leading-tight truncate max-w-[64px]">
          {label}
        </div>
        <div className="text-[8px] font-mono text-muted-foreground leading-tight truncate max-w-[64px]">
          {sublabel}
        </div>
        {valueLabel !== undefined && (
          <div
            className="text-[8px] font-mono text-foreground/70 leading-tight"
            data-testid={`gauge-value-${label}`}
          >
            {valueLabel}
          </div>
        )}
      </figcaption>
    </figure>
  );
}

/** Vertical vessel tank glyph — the SVG board's tank-straddling-the-pipe
 *  instrument, ported into node interiors (mt#2466 item 3). Fill level rises
 *  from the bottom; placeholder tanks breathe (vsm-breath) like the SVG's. */
export function VesselTank({
  label,
  count,
  max,
  isLoading,
  accentVar,
  placeholder = false,
}: {
  label: string;
  count: number | undefined;
  max: number;
  isLoading: boolean;
  accentVar: string;
  placeholder?: boolean;
}) {
  const fill = placeholder
    ? 0.25
    : count !== undefined
      ? Math.min(1, Math.max(0, count / max))
      : 0;
  const displayCount = isLoading ? "…" : (count ?? "—");
  const tankW = 26;
  const tankH = 44;
  const fillH = Math.round((tankH - 4) * fill);

  return (
    <div
      className="flex items-center gap-2.5"
      aria-label={`${label} tank: ${displayCount}`}
      data-testid={`vessel-tank-${label}`}
    >
      <svg width={tankW} height={tankH} viewBox={`0 0 ${tankW} ${tankH}`} aria-hidden="true">
        <rect
          x="0.5"
          y="0.5"
          width={tankW - 1}
          height={tankH - 1}
          rx="4"
          fill="none"
          stroke={`oklch(${accentVar} / 0.9)`}
          strokeWidth="1"
        />
        <rect
          x="2"
          y={tankH - 2 - fillH}
          width={tankW - 4}
          height={fillH}
          rx="2"
          fill={`oklch(${accentVar} / 0.35)`}
          className={placeholder ? "vsm-breath" : undefined}
        />
      </svg>
      <div className="flex flex-col gap-0.5">
        <span className="text-[9px] font-mono text-muted-foreground">{label}</span>
        <span
          className="text-[13px] font-mono font-semibold leading-none"
          style={{ color: `oklch(${accentVar} / 0.95)` }}
        >
          {displayCount}
        </span>
      </div>
    </div>
  );
}
