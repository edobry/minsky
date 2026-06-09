/**
 * PlantGridPage — the "/plant-grid" route (mt#2388).
 *
 * A responsive CSS-grid rearchitecture of the VSM-organ plant board, built in
 * PARALLEL with the SVG schematic at /plant for side-by-side comparison.
 *
 * Design rationale (from mt#2388):
 *   The SVG /plant has a fixed 1280×840 viewport that letterboxes on tall
 *   containers (mt#2387). A CSS grid fills the container via the layout engine —
 *   no letterbox/void at 1280–1600 widths, which is the comparison goal.
 *
 * Grid gains vs. /plant:
 *   + Responsive fill (no letterbox).
 *   + Data density per panel.
 *   + Organ add/remove without repositioning every coordinate.
 * Grid loses vs. /plant:
 *   - Native continuous-flow substrate (SVG dots-in-pipes is natural; grid
 *     needs a cross-panel overlay, deferred to v2).
 *   - Spatial stability / "memory palace" — organs can reflow.
 *   - Schematic/"living plant" aesthetic.
 *
 * Architecture:
 *   - Self-fetching via TanStack Query (useReadyCount shared hook).
 *   - Idle-honest motion: vsm-breath, vsm-ask-pulse, vsm-scan (same CSS
 *     classes as /plant, all prefers-reduced-motion gated in index.css).
 *   - Semantic tokens only — no raw hex.
 *   - S1 Operations spine rendered as a CONTINUOUS inline SVG inside its panel
 *     so the flow reading and v2 dot-motion stay viable.
 *
 * Deferred (v2):
 *   Cross-panel connector overlay — SVG layer drawing seam/recirc/weld BETWEEN
 *   panels. v1 keeps flow only WITHIN the S1 spine panel.
 */

import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { useReadyCount } from "../hooks/useReadyCount";

// ---------------------------------------------------------------------------
// Utility: clamp count to 0–1 fill fraction for tank level bars
// ---------------------------------------------------------------------------

function tankFill(count: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, count / max));
}

// ---------------------------------------------------------------------------
// Panel wrapper — a styled card with organ-color accent and label
// ---------------------------------------------------------------------------

interface PanelProps {
  "aria-label": string;
  className?: string;
  children: ReactNode;
  accentVar: string;
  label: string;
  sublabel?: string;
  "data-testid"?: string;
}

function Panel({
  "aria-label": ariaLabel,
  className,
  children,
  accentVar,
  label,
  sublabel,
  "data-testid": dataTestId,
}: PanelProps) {
  return (
    <section
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={cn(
        "relative flex flex-col gap-2 rounded-md border bg-card overflow-hidden",
        "p-3",
        className
      )}
      style={{ borderColor: `oklch(${accentVar} / 0.30)` }}
    >
      {/* Top accent stripe */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px]"
        style={{ background: `oklch(${accentVar} / 0.55)` }}
        aria-hidden="true"
      />
      {/* Panel header */}
      <div className="flex items-baseline gap-2 mt-0.5">
        <h2
          className="text-[11px] font-mono font-bold tracking-[0.12em] uppercase leading-none"
          style={{ color: `oklch(${accentVar} / 0.85)` }}
        >
          {label}
        </h2>
        {sublabel && (
          <span className="text-[10px] font-mono text-muted-foreground leading-none">
            {sublabel}
          </span>
        )}
      </div>
      {/* Content area */}
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// S5 Identity — full-width top bar
// ---------------------------------------------------------------------------

function S5IdentityPanel() {
  return (
    <Panel
      aria-label="S5 Identity — rules corpus and operator"
      data-testid="panel-s5-identity"
      accentVar="var(--vsm-s5)"
      label="S5 · Identity"
      sublabel="rules corpus · decision-defaults · the operator"
      className="col-span-full"
    >
      <div className="flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-muted-foreground">rules:</span>
          <span className="text-[10px] font-mono text-muted-foreground">— active</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-muted-foreground">decision-defaults:</span>
          <span className="text-[10px] font-mono text-muted-foreground">— sections</span>
        </div>
        {/* YOU node — operator terminus of attention seam */}
        <div className="ml-auto flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center w-7 h-7 rounded-full border-2 text-[10px] font-mono font-bold vsm-ask-pulse"
            style={{
              borderColor: "oklch(var(--vsm-seam) / 0.9)",
              color: "oklch(var(--vsm-seam) / 1)",
              background: "oklch(var(--vsm-seam) / 0.12)",
            }}
            aria-label="YOU — operator terminus"
          >
            YOU
          </span>
          <span className="text-[10px] font-mono text-muted-foreground">operator terminus</span>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// S3 Gauges — the 3 gauge arcs as a row
// ---------------------------------------------------------------------------

interface GaugeArcProps {
  label: string;
  sublabel: string;
  needleFraction: number;
  setpointFraction: number;
}

function GaugeArc({ label, sublabel, needleFraction, setpointFraction }: GaugeArcProps) {
  const size = 80;
  const cx = size / 2;
  const cy = size / 2 + 8;
  const r = 30;

  // Arc from -150deg to +150deg (300 degrees total)
  const startAngle = -150;
  const endAngle = 150;
  const totalRange = endAngle - startAngle;

  function angleToPoint(deg: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return {
      x: cx + Math.cos(rad) * r,
      y: cy + Math.sin(rad) * r,
    };
  }

  const arcStart = angleToPoint(startAngle);
  const arcEnd = angleToPoint(endAngle);

  const needleDeg = startAngle + needleFraction * totalRange;
  const setpointDeg = startAngle + setpointFraction * totalRange;
  const needlePt = angleToPoint(needleDeg);
  const setptInner = angleToPoint(setpointDeg);
  const setptOuter = {
    x: cx + (Math.cos(((setpointDeg - 90) * Math.PI) / 180) * (r + 10)),
    y: cy + (Math.sin(((setpointDeg - 90) * Math.PI) / 180) * (r + 10)),
  };

  return (
    <figure className="flex flex-col items-center gap-1" aria-label={`Gauge: ${label}`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        className="overflow-visible"
      >
        {/* Background arc */}
        <path
          d={`M${arcStart.x} ${arcStart.y} A${r} ${r} 0 1 1 ${arcEnd.x} ${arcEnd.y}`}
          fill="none"
          stroke="oklch(var(--border) / 1)"
          strokeWidth="6"
          strokeLinecap="round"
        />
        {/* Setpoint mark */}
        <line
          x1={setptInner.x}
          y1={setptInner.y}
          x2={setptOuter.x}
          y2={setptOuter.y}
          stroke="oklch(var(--warn-red) / 0.9)"
          strokeWidth="2"
        />
        {/* Needle */}
        <line
          x1={cx}
          y1={cy}
          x2={needlePt.x}
          y2={needlePt.y}
          stroke="oklch(var(--foreground) / 0.85)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* Pivot */}
        <circle cx={cx} cy={cy} r="2.5" fill="oklch(var(--foreground) / 0.7)" />
      </svg>
      <figcaption className="text-center">
        <div className="text-[10px] font-mono text-foreground/80 leading-tight">{label}</div>
        <div className="text-[9px] font-mono text-muted-foreground leading-tight">{sublabel}</div>
      </figcaption>
    </figure>
  );
}

function S3GaugesPanel() {
  return (
    <Panel
      aria-label="S3 Management and 3-star — gauges with alarm setpoints"
      data-testid="panel-s3-gauges"
      accentVar="var(--vsm-s3)"
      label="S3 · Management + 3★"
      sublabel="gauges with alarm setpoints"
    >
      <div className="flex items-start justify-around gap-2 flex-wrap py-1">
        <GaugeArc
          label="mcp disconnect"
          sublabel="— / 24h  (alarm 3)"
          needleFraction={0.15}
          setpointFraction={0.75}
        />
        <GaugeArc
          label="dispatch cadence"
          sublabel="— partial/sess (alarm 2)"
          needleFraction={0.10}
          setpointFraction={0.65}
        />
        <GaugeArc
          label="attention load"
          sublabel="—"
          needleFraction={0.35}
          setpointFraction={0.55}
        />
      </div>
      <div className="text-[9px] font-mono text-muted-foreground text-center mt-1">
        3★ audit sweep → over S1
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// S1 Operations — wide panel with continuous lifecycle spine SVG
// ---------------------------------------------------------------------------

interface ReadyTankInlineProps {
  count: number | undefined;
  isLoading: boolean;
}

function ReadyTankInline({ count, isLoading }: ReadyTankInlineProps) {
  const fill = count !== undefined ? tankFill(count, 20) : 0;
  const tankH = 32;
  const fillH = Math.round(tankH * fill);
  const fillY = 8 + (tankH - fillH);
  const displayCount = isLoading ? "…" : (count ?? "—");

  return (
    <g role="img" aria-label={`READY tank: ${displayCount} tasks`}>
      {/* Tank outline — straddles the pipe at y=24 */}
      <rect
        x="0" y="8" width="36" height={tankH} rx="3"
        fill="none"
        stroke="oklch(var(--vsm-s1) / 0.9)"
        strokeWidth="1"
      />
      {/* Fill level */}
      {fillH > 0 && (
        <rect
          x="2" y={fillY} width="32" height={fillH} rx="2"
          fill="oklch(var(--vsm-s1) / 0.38)"
          className="vsm-breath"
          aria-hidden="true"
        />
      )}
      {/* Label above */}
      <text
        x="18" y="4"
        textAnchor="middle"
        fontSize="7"
        letterSpacing="0.04em"
        fill="oklch(var(--muted-foreground) / 1)"
        fontFamily="var(--font-mono)"
      >
        READY
      </text>
      {/* Count below */}
      <text
        x="18" y="52"
        textAnchor="middle"
        fontSize="9"
        fill="oklch(var(--vsm-s1) / 0.9)"
        fontFamily="var(--font-mono)"
        fontWeight="600"
      >
        {displayCount}
      </text>
    </g>
  );
}

interface S1OperationsSpineProps {
  readyCount: number | undefined;
  readyLoading: boolean;
}

/**
 * The S1 lifecycle spine as a continuous inline SVG.
 *
 * Layout (total viewBox width = 580, height = 70):
 *   TASKS(x=30) → valve(x=80) → [READY tank: x=100-136] → valve(x=160) →
 *   SESSIONS(x=210) → valve(x=270) → AGENTS(x=330) → valve(x=390) →
 *   PR(x=440) → [REVIEW tank: x=460-496] → valve(x=520) → DONE(x=560)
 *
 * CHANGES_REQUESTED recirculation arc: from REVIEW tank back to SESSIONS.
 * The spine is kept continuous so v2 dot-motion (dots travelling along the
 * pipe path) can be added without restructuring the SVG.
 */
function S1OperationsSpine({ readyCount, readyLoading }: S1OperationsSpineProps) {
  const pipeY = 28;

  return (
    <svg
      viewBox="0 0 600 72"
      className="w-full"
      style={{ minHeight: "60px", maxHeight: "80px" }}
      aria-label="S1 Operations lifecycle spine: TASKS → READY → SESSIONS → AGENTS → PR → REVIEW → DONE"
      role="img"
    >
      <defs>
        <filter id="grid-s1-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Main pipe */}
      <path
        d={`M24 ${pipeY} H576`}
        stroke="oklch(var(--border) / 1)"
        strokeWidth="7"
        fill="none"
        strokeLinecap="round"
      />
      {/* Flow scan sweep */}
      <path
        className="vsm-scan"
        d={`M24 ${pipeY} H576`}
        stroke="oklch(var(--vsm-s1) / 0.5)"
        strokeWidth="2.5"
        fill="none"
        strokeDasharray="2 7"
      />

      {/* ---- Stage: TASKS ---- */}
      <circle cx="30" cy={pipeY} r="5" fill="oklch(var(--vsm-s1) / 1)" />
      <text
        x="30" y={pipeY - 10}
        textAnchor="middle"
        fontSize="7.5"
        letterSpacing="0.04em"
        fill="oklch(var(--muted-foreground) / 1)"
        fontFamily="var(--font-mono)"
      >
        TASKS
      </text>

      {/* ---- S2 valve before READY ---- */}
      <rect
        x="68" y={pipeY - 6}
        width="10" height="10"
        transform={`rotate(45 73 ${pipeY})`}
        fill="oklch(var(--background) / 1)"
        stroke="oklch(var(--vsm-s2) / 1)"
        strokeWidth="1.2"
        role="img"
        aria-label="Interlock valve before READY"
      />

      {/* ---- READY tank (the one real level) ---- */}
      {/* Centered at x=118, tank width=36, shifted for the tank group origin */}
      <g transform={`translate(100 ${pipeY - 28})`}>
        <ReadyTankInline count={readyCount} isLoading={readyLoading} />
      </g>

      {/* ---- S2 valve after READY ---- */}
      <rect
        x="148" y={pipeY - 6}
        width="10" height="10"
        transform={`rotate(45 153 ${pipeY})`}
        fill="oklch(var(--background) / 1)"
        stroke="oklch(var(--vsm-s2) / 1)"
        strokeWidth="1.2"
        role="img"
        aria-label="Interlock valve after READY"
      />

      {/* ---- Stage: SESSIONS ---- */}
      <circle
        cx="210" cy={pipeY}
        r="6"
        fill="oklch(var(--vsm-s1) / 1)"
        filter="url(#grid-s1-glow)"
      />
      <text
        x="210" y={pipeY - 10}
        textAnchor="middle"
        fontSize="7.5"
        letterSpacing="0.04em"
        fill="oklch(var(--muted-foreground) / 1)"
        fontFamily="var(--font-mono)"
      >
        SESSIONS
      </text>
      <text
        x="210" y={pipeY + 16}
        textAnchor="middle"
        fontSize="7"
        fill="oklch(var(--muted-foreground) / 0.7)"
        fontFamily="var(--font-mono)"
      >
        — active
      </text>

      {/* ---- S2 valve before AGENTS ---- */}
      <rect
        x="268" y={pipeY - 6}
        width="10" height="10"
        transform={`rotate(45 273 ${pipeY})`}
        fill="oklch(var(--background) / 1)"
        stroke="oklch(var(--vsm-s2) / 1)"
        strokeWidth="1.2"
        role="img"
        aria-label="Interlock valve before AGENTS"
      />

      {/* ---- Stage: AGENTS ---- */}
      {/* Cluster of 4 small circles */}
      <g fill="oklch(var(--vsm-s1) / 0.8)">
        <circle cx="323" cy={pipeY} r="3.5" />
        <circle cx="333" cy={pipeY - 5} r="3.5" />
        <circle cx="343" cy={pipeY} r="3.5" />
        <circle cx="333" cy={pipeY + 5} r="3.5" />
      </g>
      <text
        x="333" y={pipeY - 12}
        textAnchor="middle"
        fontSize="7.5"
        letterSpacing="0.04em"
        fill="oklch(var(--muted-foreground) / 1)"
        fontFamily="var(--font-mono)"
      >
        AGENTS
      </text>
      <text
        x="333" y={pipeY + 18}
        textAnchor="middle"
        fontSize="7"
        fill="oklch(var(--muted-foreground) / 0.7)"
        fontFamily="var(--font-mono)"
      >
        — dispatched
      </text>

      {/* ---- S2 valve before PR ---- */}
      <rect
        x="388" y={pipeY - 6}
        width="10" height="10"
        transform={`rotate(45 393 ${pipeY})`}
        fill="oklch(var(--background) / 1)"
        stroke="oklch(var(--vsm-s2) / 1)"
        strokeWidth="1.2"
        role="img"
        aria-label="Interlock valve before PR"
      />

      {/* ---- Stage: PR ---- */}
      <circle cx="440" cy={pipeY} r="5" fill="oklch(var(--vsm-s1) / 1)" />
      <text
        x="440" y={pipeY - 10}
        textAnchor="middle"
        fontSize="7.5"
        letterSpacing="0.04em"
        fill="oklch(var(--muted-foreground) / 1)"
        fontFamily="var(--font-mono)"
      >
        PR
      </text>

      {/* ---- REVIEW tank ---- */}
      <rect
        x="460" y={pipeY - 16}
        width="36" height="32"
        rx="3"
        fill="none"
        stroke="oklch(var(--vsm-s1) / 0.9)"
        strokeWidth="1"
      />
      <rect
        x="462" y={pipeY + 2}
        width="32" height="12"
        rx="2"
        fill="oklch(var(--vsm-s1) / 0.28)"
        className="vsm-breath"
        aria-hidden="true"
      />
      <text
        x="478" y={pipeY - 18}
        textAnchor="middle"
        fontSize="7"
        letterSpacing="0.04em"
        fill="oklch(var(--muted-foreground) / 1)"
        fontFamily="var(--font-mono)"
      >
        REVIEW
      </text>
      <text
        x="478" y={pipeY + 26}
        textAnchor="middle"
        fontSize="7"
        fill="oklch(var(--muted-foreground) / 0.7)"
        fontFamily="var(--font-mono)"
      >
        —
      </text>

      {/* ---- S2 valve before DONE ---- */}
      <rect
        x="518" y={pipeY - 6}
        width="10" height="10"
        transform={`rotate(45 523 ${pipeY})`}
        fill="oklch(var(--background) / 1)"
        stroke="oklch(var(--vsm-s2) / 1)"
        strokeWidth="1.2"
        role="img"
        aria-label="Interlock valve before DONE"
      />

      {/* ---- Stage: DONE ---- */}
      <circle cx="566" cy={pipeY} r="6" fill="oklch(var(--liveness-healthy) / 1)" />
      <text
        x="566" y={pipeY - 10}
        textAnchor="middle"
        fontSize="7.5"
        letterSpacing="0.04em"
        fill="oklch(var(--muted-foreground) / 1)"
        fontFamily="var(--font-mono)"
      >
        DONE
      </text>

      {/* ---- CHANGES_REQUESTED recirculation arc ---- */}
      {/* Sweeps from REVIEW tank top back up and back down to SESSIONS */}
      <path
        d={`M478 ${pipeY - 16} C478 -12, 210 -12, 210 ${pipeY - 6}`}
        fill="none"
        stroke="oklch(var(--vsm-s1) / 0.38)"
        strokeDasharray="3 5"
        strokeWidth="1.2"
      />
      <text
        x="340" y="0"
        textAnchor="middle"
        fontSize="7"
        letterSpacing="0.04em"
        fill="oklch(var(--muted-foreground) / 0.65)"
        fontFamily="var(--font-mono)"
      >
        ⟲ CHANGES_REQUESTED
      </text>
    </svg>
  );
}

function S1OperationsPanel({ readyCount, readyLoading }: S1OperationsSpineProps) {
  return (
    <Panel
      aria-label="S1 Operations — the main process line"
      data-testid="panel-s1-operations"
      accentVar="var(--vsm-s1)"
      label="S1 · Operations"
      sublabel="lifecycle spine · READY tank live · all other levels —"
      className="col-span-full md:col-span-2"
    >
      <div className="flex flex-col gap-1">
        <S1OperationsSpine readyCount={readyCount} readyLoading={readyLoading} />
        <div className="text-[9px] font-mono text-muted-foreground/60 text-center">
          ◇ = S2 interlock (hook/guard) · flashes red=blocked / amber=override (v2)
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// S4 Future panel
// ---------------------------------------------------------------------------

function S4FuturePanel() {
  return (
    <Panel
      aria-label="S4 Future — roadmap feed and deploy loop"
      data-testid="panel-s4-future"
      accentVar="var(--vsm-s4)"
      label="S4 · Future"
      sublabel="roadmap · deploy loop · knowledge sources"
    >
      <div className="flex flex-col gap-2">
        {/* Backlog feed tank — compact representation */}
        <div className="flex items-center gap-2">
          <div
            className="w-6 flex-none rounded border overflow-hidden"
            style={{
              height: "40px",
              borderColor: "oklch(var(--vsm-s4) / 0.6)",
            }}
            aria-label="Backlog feed tank"
          >
            <div
              className="w-full vsm-breath"
              style={{
                height: "45%",
                marginTop: "55%",
                background: "oklch(var(--vsm-s4) / 0.30)",
              }}
              aria-hidden="true"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-muted-foreground">backlog feed</span>
            <span className="text-[10px] font-mono text-muted-foreground">PLANNING — · TODO —</span>
          </div>
        </div>
        {/* Deploy loop */}
        <div
          className="rounded border px-2 py-1 text-[10px] font-mono text-muted-foreground"
          style={{ borderColor: "oklch(var(--vsm-s4) / 0.35)" }}
        >
          <span className="text-muted-foreground/60">deploy loop</span>
          {" "}
          build → smoke →{" "}
          <span style={{ color: "oklch(var(--liveness-healthy) / 1)" }}>live ✓</span>
        </div>
        <div className="text-[10px] font-mono text-muted-foreground">
          knowledge sources ▸ —
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Attention / Ask seam panel
// ---------------------------------------------------------------------------

function AttentionSeamPanel() {
  return (
    <Panel
      aria-label="Attention seam — cognition coupling between system and operator"
      data-testid="panel-attention-seam"
      accentVar="var(--vsm-seam)"
      label="Attention · Ask Seam"
      sublabel="cognition coupling"
    >
      <div className="flex flex-col gap-2">
        {/* Seam visualization — ask bubble */}
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center w-5 h-5 rounded-full vsm-ask-pulse text-[9px] font-mono font-bold"
            style={{
              background: "oklch(var(--vsm-seam) / 0.18)",
              border: "1.5px solid oklch(var(--vsm-seam) / 0.7)",
              color: "oklch(var(--vsm-seam) / 1)",
            }}
            aria-label="Pending ask"
          >
            ↑
          </span>
          <span
            className="text-[10px] font-mono"
            style={{ color: "oklch(var(--vsm-seam) / 0.9)" }}
          >
            ask pending
          </span>
        </div>
        <div
          className="text-[9px] font-mono"
          style={{ color: "oklch(var(--vsm-seam) / 0.55)" }}
        >
          decision ↓ unblocks
        </div>
        {/* Dashed seam line */}
        <div
          className="w-px self-start ml-2.5"
          style={{
            height: "20px",
            borderLeft: "1.5px dashed oklch(var(--vsm-seam) / 0.35)",
          }}
          aria-hidden="true"
        />
        <div className="text-[9px] font-mono text-muted-foreground">
          asks open: —
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Learning loop panel
// ---------------------------------------------------------------------------

function LearningLoopPanel() {
  return (
    <Panel
      aria-label="Learning loop — failure to retrospective to memory to rule to new interlock"
      data-testid="panel-learning-loop"
      accentVar="var(--vsm-learn)"
      label="Learning Loop"
      sublabel="failure → retrospective → memory → rule → interlock"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1 flex-wrap text-[10px] font-mono text-muted-foreground">
          <span>failure</span>
          <span className="text-muted-foreground/40">▸</span>
          <span>retrospective</span>
          <span className="text-muted-foreground/40">▸</span>
          {/* Memory reservoir */}
          <span
            className="px-1.5 py-0.5 rounded border vsm-breath"
            style={{
              borderColor: "oklch(var(--vsm-learn) / 0.6)",
              color: "oklch(var(--vsm-learn) / 0.9)",
            }}
          >
            memory · —
          </span>
          <span className="text-muted-foreground/40">▸</span>
          <span>rule</span>
          <span className="text-muted-foreground/40">▸</span>
          <span style={{ color: "oklch(var(--vsm-learn) / 0.7)" }}>
            ⟂ new interlock welded onto S1
          </span>
        </div>
        <div
          className="text-[9px] font-mono text-muted-foreground/55"
        >
          glows new, fades to plant over days (v2)
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Infra Supply panel
// ---------------------------------------------------------------------------

function InfraSupplyPanel() {
  return (
    <Panel
      aria-label="Infrastructure supply band"
      data-testid="panel-infra-supply"
      accentVar="var(--border)"
      label="Infra Supply"
      sublabel="supply chain for the plant"
      className="col-span-full"
    >
      <div className="flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: "oklch(var(--liveness-healthy) / 1)" }}
            aria-hidden="true"
          />
          <span className="text-[10px] font-mono text-muted-foreground">MCP server — —</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: "oklch(var(--muted-foreground) / 0.5)" }}
            aria-hidden="true"
          />
          <span className="text-[10px] font-mono text-muted-foreground">Postgres — —</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: "oklch(var(--muted-foreground) / 0.5)" }}
            aria-hidden="true"
          />
          <span className="text-[10px] font-mono text-muted-foreground">credentials — —</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: "oklch(var(--muted-foreground) / 0.5)" }}
            aria-hidden="true"
          />
          <span className="text-[10px] font-mono text-muted-foreground">embeddings — —</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: "oklch(var(--vsm-learn) / 0.7)" }}
            aria-hidden="true"
          />
          <span className="text-[10px] font-mono text-muted-foreground">reviewer bot — —</span>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Main: PlantGridPage
// ---------------------------------------------------------------------------

/**
 * PlantGridPage — responsive CSS-grid VSM organ layout.
 *
 * Grid layout (12-column logical):
 *   Row 1: S5 Identity (full width)
 *   Row 2: S1 Operations (8 cols) | S3 Gauges (4 cols)
 *   Row 3: S4 Future (3 cols) | Attention/Ask seam (3 cols) | Learning loop (6 cols)
 *   Row 4: Infra Supply (full width)
 *
 * At narrower widths (< md) all panels stack vertically.
 */
export function PlantGridPage() {
  const { data: readyCount, isLoading: readyLoading } = useReadyCount();

  return (
    <div
      className="flex flex-col h-full bg-background text-foreground overflow-hidden"
      data-testid="plant-grid-page"
    >
      {/* Header */}
      <header className="flex items-baseline gap-4 px-[18px] py-[10px] border-b border-border flex-none">
        <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">
          MINSKY · PLANT GRID
        </h1>
        <span className="text-[11px] font-mono text-muted-foreground">
          v1 · panel-grid layout · READY tank live · idle-honest
        </span>
        <span className="ml-auto flex items-center gap-3 text-[11px] font-mono">
          <span className="text-liveness-healthy">● system nominal</span>
          {/* Cross-link to the SVG schematic */}
          <Link
            to="/plant"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Switch to SVG schematic layout"
          >
            ▢ schematic layout
          </Link>
        </span>
      </header>

      {/* Grid board — fills the remaining height */}
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {/*
          Responsive grid:
          - Default (mobile): single column, all panels stacked
          - md (768+): 3-column grid
          - lg (1024+): 3-column grid with wider panels
          Uses auto rows (min-content) so panels don't stretch vertically to equal height.
        */}
        <div
          className="grid gap-3 h-full"
          style={{
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gridTemplateRows: "auto 1fr auto auto",
            alignContent: "start",
          }}
          data-testid="plant-grid-board"
        >
          {/* Row 1: S5 Identity — full width */}
          <S5IdentityPanel />

          {/* Row 2: S1 Operations (2/3 width) + S3 Gauges (1/3 width) */}
          <S1OperationsPanel readyCount={readyCount} readyLoading={readyLoading} />
          <S3GaugesPanel />

          {/* Row 3: S4 Future + Attention Seam + Learning Loop */}
          <S4FuturePanel />
          <AttentionSeamPanel />
          <LearningLoopPanel />

          {/* Row 4: Infra Supply — full width */}
          <InfraSupplyPanel />
        </div>
      </div>
    </div>
  );
}