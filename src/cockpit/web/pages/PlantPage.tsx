/**
 * PlantPage — the "/plant" route.
 *
 * VSM-organ whole-system schematic ("living plant") — v1 slice (mt#2376).
 *
 * This is a static-layout-plus-one-real-level slice:
 *   - Full VSM-organ skeleton (S5/S4/S1/S2/S3 + attention seam + learning loop
 *     + infra supply) rendered faithfully from the design reference mock.
 *   - ONE level wired to real data: READY tank count from GET /api/tasks via
 *     TanStack Query (staleTime 30s, refetchInterval 60s).
 *   - All other levels stay as clearly-labelled "—" placeholders.
 *
 * Idle-honesty is a hard constraint:
 *   - Only three gestures move: the 3★ scan sweep, the slow tank breath, and the
 *     pending-ask pulse.
 *   - No event → no motion. A calm system reads calm.
 *
 * Color discipline:
 *   - Semantic tokens only. VSM organ palette uses new --vsm-* CSS tokens added
 *     to index.css and mapped in tailwind.config.ts.
 *   - No raw hex anywhere.
 *
 * Architecture notes:
 *   - Self-fetching via TanStack Query (no prop drilling).
 *   - Decomposed into sub-components: S5Canopy, S4Future, S1Operations,
 *     S3Gauges, AttentionSeam, LearningLoop, InfraSupply, PlanLegend.
 *   - SVG layout faithfully ported from the hand-built mock at
 *     /tmp/cockpit-plant-board-v1.html.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { PanZoomSVG } from "../components/PanZoomSVG";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskListItem {
  id: string;
  title: string;
  status: string;
}

interface TaskListResponse {
  tasks: TaskListItem[];
}

// ---------------------------------------------------------------------------
// Data fetching — READY tank count only (one real level, everything else placeholder)
// ---------------------------------------------------------------------------

async function fetchReadyTaskCount(): Promise<number> {
  const res = await fetch("/api/tasks");
  if (!res.ok) throw new Error(`tasks API: ${res.status}`);
  const body = (await res.json()) as TaskListResponse;
  return body.tasks.filter((t) => t.status === "READY").length;
}

function useReadyCount() {
  return useQuery({
    queryKey: ["plant-board", "ready-count"],
    queryFn: fetchReadyTaskCount,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Utility: clamp a count to a 0–1 fill fraction for tank level bars
// ---------------------------------------------------------------------------

function tankFill(count: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, count / max));
}

// ---------------------------------------------------------------------------
// Sub-component: S5 Identity canopy
// ---------------------------------------------------------------------------

function S5Canopy() {
  return (
    <g role="region" aria-label="S5 Identity — rules corpus and operator">
      {/* Canopy border */}
      <rect
        x="20" y="14" width="1180" height="56" rx="8"
        fill="oklch(var(--vsm-s5) / 0.04)"
        stroke="oklch(var(--vsm-s5) / 0.28)"
        strokeWidth="1"
      />
      <text x="34" y="38" className="vsm-organ-label" fill="oklch(var(--vsm-s5) / 1)" fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fontFamily="var(--font-mono)">S5 · IDENTITY</text>
      <text x="34" y="56" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">rules corpus · decision-defaults · the operator</text>
      <text x="640" y="38" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">rules: — active</text>
      <text x="640" y="54" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">decision-defaults: — sections</text>
      {/* YOU node — operator terminus of attention seam */}
      <circle
        cx="1030" cy="42" r="14"
        fill="oklch(var(--vsm-seam) / 0.22)"
        stroke="oklch(var(--vsm-seam) / 0.9)"
        filter="url(#seam-glow)"
      />
      <text x="1052" y="46" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-seam) / 1)" fontFamily="var(--font-mono)">YOU</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: S4 Future (feed tank + deploy loop)
// ---------------------------------------------------------------------------

function S4Future() {
  return (
    <g role="region" aria-label="S4 Future — roadmap feed and deploy loop">
      <text x="34" y="90" fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fill="oklch(var(--vsm-s4) / 1)" fontFamily="var(--font-mono)">S4 · FUTURE</text>

      {/* Backlog feed tank — tall to fill vertical space between canopy and S1 */}
      <rect x="34" y="106" width="86" height="200" rx="6" fill="none" stroke="oklch(var(--vsm-s4) / 0.9)" strokeWidth="1"/>
      {/* Placeholder fill level (~45%) */}
      <rect
        x="36" y="216" width="82" height="88" rx="4"
        fill="oklch(var(--vsm-s4) / 0.30)"
        className="vsm-breath"
      />
      <text x="34" y="100" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">backlog feed</text>
      <text x="77" y="322" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">PLANNING — · TODO —</text>
      <text x="34" y="344" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">knowledge sources ▸ —</text>

      {/* Deploy loop */}
      <text x="34" y="366" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">deploy loop</text>
      <rect x="34" y="376" width="240" height="36" rx="6" fill="none" stroke="oklch(var(--vsm-s4) / 0.50)" strokeWidth="1"/>
      <text x="44" y="398" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">
        build → smoke → <tspan fill="oklch(var(--liveness-healthy) / 1)">live ✓</tspan>
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Ready tank (the ONE wired level)
// ---------------------------------------------------------------------------

interface ReadyTankProps {
  count: number | undefined;
  isLoading: boolean;
}

function ReadyTank({ count, isLoading }: ReadyTankProps) {
  const fill = count !== undefined ? tankFill(count, 20) : 0;
  // Visual tank: 60px tall, fill from bottom; tank top at y=470, pipe at y=510
  const tankH = 60;
  const fillH = Math.round(tankH * fill);
  const fillY = 470 + (tankH - fillH);
  const displayCount = isLoading ? "…" : (count ?? "—");

  return (
    <g role="img" aria-label={`READY tank: ${displayCount} tasks`}>
      {/* Tank outline */}
      <rect x="300" y="470" width="60" height={tankH} rx="5" fill="none" stroke="oklch(var(--vsm-s1) / 0.9)" strokeWidth="1"/>
      {/* Fill level — real data */}
      {fillH > 0 && (
        <rect
          x="302" y={fillY} width="56" height={fillH} rx="3"
          fill="oklch(var(--vsm-s1) / 0.40)"
          className="vsm-breath"
          aria-hidden="true"
        />
      )}
      <text x="330" y="464" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">READY</text>
      <text x="330" y="546" textAnchor="middle" fontSize="11" fill="oklch(var(--vsm-s1) / 0.9)" fontFamily="var(--font-mono)" fontWeight="600">
        {displayCount}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: S1 Operations (the main process line)
// ---------------------------------------------------------------------------

interface S1OperationsProps {
  readyCount: number | undefined;
  readyLoading: boolean;
}

function S1Operations({ readyCount, readyLoading }: S1OperationsProps) {
  return (
    <g role="region" aria-label="S1 Operations — the main process line">
      {/* Region background — pipe at y=510; region y=420-580 */}
      <rect
        x="150" y="420" width="900" height="160" rx="10"
        fill="oklch(var(--vsm-s1) / 0.04)"
        stroke="oklch(var(--vsm-s1) / 0.22)"
        strokeWidth="1"
      />
      <text x="164" y="440" fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fill="oklch(var(--vsm-s1) / 1)" fontFamily="var(--font-mono)">S1 · OPERATIONS</text>

      {/* Main pipe at y=510 */}
      <path d="M180 510 H1020" stroke="oklch(var(--border) / 1)" strokeWidth="10" fill="none" strokeLinecap="round"/>
      {/* Flow dashes — slow 3★ scan sweep (CSS stroke-dashoffset so prefers-reduced-motion gates it) */}
      <path className="vsm-scan" d="M180 510 H1020" stroke="oklch(var(--vsm-s1) / 0.5)" strokeWidth="3" fill="none" strokeDasharray="2 7"/>

      {/* Stage: TASKS */}
      <text x="200" y="494" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">TASKS</text>
      <circle cx="200" cy="510" r="6" fill="oklch(var(--vsm-s1) / 1)"/>

      {/* READY tank — one real level; tank y=470–530 straddles pipe */}
      <ReadyTank count={readyCount} isLoading={readyLoading} />

      {/* Stage: SESSIONS */}
      <text x="470" y="494" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">SESSIONS</text>
      <circle cx="470" cy="510" r="7" fill="oklch(var(--vsm-s1) / 1)" filter="url(#s1-glow)"/>
      <text x="470" y="562" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">— active</text>

      {/* Stage: AGENTS */}
      <text x="620" y="494" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">AGENTS</text>
      <g fill="oklch(var(--vsm-s1) / 0.8)">
        <circle cx="606" cy="510" r="4"/>
        <circle cx="620" cy="503" r="4"/>
        <circle cx="634" cy="510" r="4"/>
        <circle cx="620" cy="517" r="4"/>
      </g>
      <text x="620" y="562" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">— dispatched</text>

      {/* Stage: PR */}
      <text x="770" y="494" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">PR</text>
      <circle cx="770" cy="510" r="6" fill="oklch(var(--vsm-s1) / 1)"/>

      {/* Review tank — 60px tall, straddles pipe */}
      <rect x="850" y="480" width="60" height="60" rx="5" fill="none" stroke="oklch(var(--vsm-s1) / 0.9)" strokeWidth="1"/>
      <rect
        x="852" y="524" width="56" height="14" rx="3"
        fill="oklch(var(--vsm-s1) / 0.35)"
        className="vsm-breath"
      />
      <text x="880" y="474" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">REVIEW</text>
      <text x="880" y="562" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">—</text>

      {/* CHANGES_REQUESTED recirculation arc — sweeps up through S4/S3 region */}
      <path
        d="M880 480 C880 360, 470 360, 470 492"
        fill="none"
        stroke="oklch(var(--vsm-s1) / 0.4)"
        strokeDasharray="4 5"
        strokeWidth="1.5"
      />
      <text x="660" y="354" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">⟲ CHANGES_REQUESTED recirculates</text>

      {/* Stage: DONE */}
      <text x="1015" y="494" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">DONE</text>
      <circle cx="1015" cy="510" r="7" fill="oklch(var(--liveness-healthy) / 1)"/>

      {/* S2 interlock valves (◇) on the pipe */}
      <g fill="oklch(var(--background) / 1)" stroke="oklch(var(--vsm-s2) / 1)" strokeWidth="1.5" aria-label="S2 interlock valves">
        {/* Before READY */}
        <rect x="252" y="502" width="16" height="16" transform="rotate(45 260 510)" role="img" aria-label="Interlock valve before READY"/>
        {/* Before SESSIONS */}
        <rect x="412" y="502" width="16" height="16" transform="rotate(45 420 510)" role="img" aria-label="Interlock valve before SESSIONS"/>
        {/* Before PR */}
        <rect x="692" y="502" width="16" height="16" transform="rotate(45 700 510)" role="img" aria-label="Interlock valve before PR"/>
        {/* Before DONE */}
        <rect x="952" y="502" width="16" height="16" transform="rotate(45 960 510)" role="img" aria-label="Interlock valve before DONE"/>
      </g>
      <text x="700" y="596" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-s2) / 0.9)" fontFamily="var(--font-mono)">◇ = S2 interlock (hook/guard) · flashes red=blocked / amber=override (v2)</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: S3 Management + 3★ gauges
// ---------------------------------------------------------------------------

interface GaugeProps {
  cx: number;
  cy: number;
  label: string;
  sublabel: string;
  /** needle angle in degrees from -90 (left) to 90 (right) */
  needleAngle: number;
  /** setpoint angle in degrees */
  setpointAngle: number;
}

function Gauge({ cx, cy, label, sublabel, needleAngle, setpointAngle }: GaugeProps) {
  // Convert angles to unit-circle coordinates for line endpoints
  const needleRad = ((needleAngle - 90) * Math.PI) / 180;
  const setpointRad = ((setpointAngle - 90) * Math.PI) / 180;
  const nx = cx + Math.cos(needleRad) * 30;
  const ny = cy + Math.sin(needleRad) * 30;
  const sx1 = cx + Math.cos(setpointRad) * 38;
  const sy1 = cy + Math.sin(setpointRad) * 38;
  const sx2 = cx + Math.cos(setpointRad) * 50;
  const sy2 = cy + Math.sin(setpointRad) * 50;

  return (
    <g role="img" aria-label={`Gauge: ${label} — ${sublabel}`}>
      {/* Arc background */}
      <path
        d={`M${cx - 46} ${cy} A46 46 0 0 1 ${cx + 46} ${cy}`}
        fill="none"
        stroke="oklch(var(--border) / 1)"
        strokeWidth="8"
      />
      {/* Alarm setpoint mark */}
      <line
        x1={sx1} y1={sy1} x2={sx2} y2={sy2}
        stroke="oklch(var(--warn-red) / 1)"
        strokeWidth="2"
      />
      {/* Needle */}
      <line
        x1={cx} y1={cy} x2={nx} y2={ny}
        stroke="oklch(var(--foreground) / 1)"
        strokeWidth="2"
      />
      {/* Labels */}
      <text x={cx} y={cy + 22} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">{label}</text>
      <text x={cx} y={cy + 36} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">{sublabel}</text>
    </g>
  );
}

function S3Gauges() {
  return (
    <g role="region" aria-label="S3 Management and 3-star — gauges with alarm setpoints">
      <text x="1110" y="90" fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fill="oklch(var(--vsm-s3) / 1)" fontFamily="var(--font-mono)">S3 · 3★</text>

      {/* Gauge 1: MCP disconnect cadence — alarm at 3/24h */}
      <Gauge
        cx={1165} cy={160}
        label="mcp disconnect"
        sublabel="— / 24h  (alarm 3)"
        needleAngle={-60}
        setpointAngle={60}
      />

      {/* Gauge 2: subagent dispatch cadence — alarm at 2/session */}
      <Gauge
        cx={1165} cy={278}
        label="dispatch cadence"
        sublabel="— partial/sess (alarm 2)"
        needleAngle={-80}
        setpointAngle={45}
      />

      {/* Gauge 3: attention load */}
      <Gauge
        cx={1165} cy={396}
        label="attention load"
        sublabel="—"
        needleAngle={-40}
        setpointAngle={20}
      />

      <text x="1165" y="460" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">3★ audit sweep ⟶ over S1</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Attention / Ask seam
// ---------------------------------------------------------------------------

function AttentionSeam() {
  return (
    <g role="region" aria-label="Attention seam — cognition coupling between system and operator">
      {/* Vertical dashed line from S1 region top (y=420) up to YOU node (y=56) */}
      <line
        x1="1030" y1="420" x2="1030" y2="56"
        stroke="oklch(var(--vsm-seam) / 0.6)"
        strokeWidth="2.5"
        strokeDasharray="3 4"
      />
      <text x="1042" y="230" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-seam) / 1)" fontFamily="var(--font-mono)">attention seam</text>

      {/* Pending ask — pulses when open */}
      <circle
        cx="1030" cy="250" r="6"
        fill="oklch(var(--vsm-seam) / 1)"
        filter="url(#seam-glow)"
        className="vsm-ask-pulse"
        aria-label="Pending ask"
      />
      <text x="1042" y="254" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-seam) / 1)" fontFamily="var(--font-mono)">ask pending ↑</text>
      <text x="1042" y="290" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-seam) / 0.65)" fontFamily="var(--font-mono)">decision ↓ unblocks</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Learning loop
// ---------------------------------------------------------------------------

function LearningLoop() {
  return (
    <g role="region" aria-label="Learning loop — failure to retrospective to memory to rule to new interlock">
      <text x="164" y="620" fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fill="oklch(var(--vsm-learn) / 1)" fontFamily="var(--font-mono)">LEARNING LOOP</text>

      {/* Flow path */}
      <path
        d="M200 640 H980"
        stroke="oklch(var(--vsm-learn) / 0.35)"
        strokeWidth="2"
        fill="none"
        strokeDasharray="2 6"
      />

      {/* Labels along the loop */}
      <text x="210" y="634" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">failure</text>
      <text x="330" y="634" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">▸ retrospective</text>

      {/* Memory reservoir tank */}
      <rect x="470" y="616" width="120" height="44" rx="6" fill="none" stroke="oklch(var(--vsm-learn) / 1)" strokeWidth="1"/>
      <rect
        x="472" y="638" width="116" height="20" rx="3"
        fill="oklch(var(--vsm-learn) / 0.30)"
        className="vsm-breath"
      />
      <text x="530" y="610" textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">memory reservoir · —</text>

      {/* Continuing loop labels */}
      <text x="650" y="634" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">▸ rule</text>
      <text x="740" y="634" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">▸ ⟂ new interlock welded onto S1 (glows, fades over days)</text>

      {/* Arc closing back onto an S2 valve — connects up from y=616 to the pipe level */}
      <path
        d="M962 616 C962 568, 962 536, 960 512"
        fill="none"
        stroke="oklch(var(--vsm-learn) / 0.4)"
        strokeDasharray="2 5"
        strokeWidth="1.5"
      />
      <text x="970" y="568" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-learn) / 0.7)" fontFamily="var(--font-mono)">↑ closes onto an S2 valve</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Infra supply band (bottom)
// ---------------------------------------------------------------------------

function InfraSupply() {
  return (
    <g role="region" aria-label="Infrastructure supply band">
      <rect x="20" y="720" width="1180" height="100" rx="8" fill="none" stroke="oklch(var(--border) / 1)" strokeWidth="1"/>
      <text x="34" y="738" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">INFRA SUPPLY</text>
      <text x="34" y="758" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--liveness-healthy) / 1)" fontFamily="var(--font-mono)">● MCP server — —</text>
      <text x="34" y="776" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">● Postgres — —</text>
      <text x="34" y="794" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">● credentials — —</text>
      <text x="640" y="758" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">● embeddings — —</text>
      <text x="640" y="776" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-learn) / 0.8)" fontFamily="var(--font-mono)">reviewer bot — —</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Legend sidebar (collapsible to preserve board space)
// ---------------------------------------------------------------------------

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 my-1 text-xs font-mono">
      <span
        className="flex-none w-3 h-3 rounded-sm"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function PlantLegend() {
  const [open, setOpen] = useState(true);

  return (
    <aside
      className={cn(
        "border-l border-border bg-card flex-none flex flex-col transition-[width]",
        open ? "w-[200px]" : "w-[32px]"
      )}
      aria-label="Plant board legend"
    >
      {/* Toggle button — always visible */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Collapse legend" : "Expand legend"}
        aria-expanded={open}
        className={cn(
          "flex items-center justify-center flex-none",
          "w-8 h-8 border-b border-border",
          "text-muted-foreground text-[10px] font-mono",
          "hover:bg-secondary hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open ? "self-end" : "self-center"
        )}
      >
        {open ? "›" : "‹"}
      </button>

      {/* Content — hidden when collapsed */}
      {open && (
        <div className="overflow-auto p-3 text-xs font-mono flex-1">
          <h2 className="text-muted-foreground uppercase tracking-widest text-[10px] mb-1.5 mt-0">Timescale grammar</h2>
          <p className="text-muted-foreground text-[10px] my-1"><strong className="text-foreground">STABLE</strong> — pipes, stages, gauges, organs.</p>
          <p className="text-muted-foreground text-[10px] my-1"><strong className="text-foreground">FLUID</strong> — instances as flow-rate/level.</p>
          <p className="text-muted-foreground text-[10px] my-1"><strong className="text-foreground">BREATH</strong> — tank levels, ~60s poll.</p>
          <p className="text-muted-foreground text-[10px] my-1"><strong className="text-foreground">SLOW</strong> — plant grows valves (weld).</p>

          <h2 className="text-muted-foreground uppercase tracking-widest text-[10px] mb-1.5 mt-3.5">Organs (VSM)</h2>
          <LegendItem color="oklch(var(--vsm-s1) / 1)" label="S1 operations" />
          <LegendItem color="oklch(var(--vsm-s2) / 1)" label="S2 coordination (valves)" />
          <LegendItem color="oklch(var(--vsm-s3) / 1)" label="S3 management + 3★" />
          <LegendItem color="oklch(var(--vsm-s4) / 1)" label="S4 future" />
          <LegendItem color="oklch(var(--vsm-s5) / 1)" label="S5 identity" />
          <LegendItem color="oklch(var(--vsm-seam) / 1)" label="attention seam (cognition)" />
          <LegendItem color="oklch(var(--vsm-learn) / 1)" label="learning loop" />

          <h2 className="text-muted-foreground uppercase tracking-widest text-[10px] mb-1.5 mt-3.5">Idle honesty</h2>
          <p className="text-muted-foreground text-[10px] my-1">Only the <strong className="text-foreground">3★ sweep</strong>, slow <strong className="text-foreground">breath</strong>, and a <strong className="text-foreground">pending ask</strong> pulse move here.</p>

          <h2 className="text-muted-foreground uppercase tracking-widest text-[10px] mb-1.5 mt-3.5">v1 = real</h2>
          <p className="text-muted-foreground text-[10px] my-1">READY tank wires to <strong className="text-foreground">/api/tasks</strong>. All other levels are <strong className="text-foreground">—</strong> placeholders.</p>

          <h2 className="text-muted-foreground uppercase tracking-widest text-[10px] mb-1.5 mt-3.5">Deferred</h2>
          <p className="text-muted-foreground text-[10px] my-1">Fast-clock = <strong className="text-foreground">v2</strong>. Phone = <strong className="text-foreground">v3</strong>.</p>
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: SVG defs (filters + animations)
// ---------------------------------------------------------------------------

function SvgDefs() {
  return (
    <defs>
      {/* Glow filter for the seam / S1 living nodes */}
      <filter id="seam-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
      <filter id="s1-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
  );
}

// ---------------------------------------------------------------------------
// Main: PlantPage
// ---------------------------------------------------------------------------

export function PlantPage() {
  const { data: readyCount, isLoading: readyLoading } = useReadyCount();

  return (
    <div
      className={cn(
        "flex flex-col h-full bg-background text-foreground overflow-hidden",
        "vsm-plant-page"
      )}
      data-testid="plant-page"
    >
      {/* Header */}
      <header className="flex items-baseline gap-4 px-[18px] py-[10px] border-b border-border flex-none">
        <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">MINSKY · WHOLE-SYSTEM PLANT</h1>
        <span className="text-[11px] font-mono text-muted-foreground">
          v1 · READY tank live · all other levels placeholder · idle-honest
        </span>
        <span className="ml-auto flex items-center gap-3 text-[11px] font-mono">
          <span className="text-liveness-healthy">● system nominal</span>
          {/* Cross-link to the panel-grid layout (mt#2388) */}
          <Link
            to="/plant-grid"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Switch to panel-grid layout"
          >
            ▢ grid layout
          </Link>
        </span>
      </header>

      {/* Board + Legend */}
      <div className="flex flex-1 min-h-0">
        {/*
          Pan/zoom board: uses PanZoomSVG for wheel-zoom + pointer-drag.
          Legible default: fit-width (boardWidth=1280). On a 1280px viewport the
          board renders at scale 1.0, giving full-size text. Fit-height would
          shrink to ~87% on a 720px content area, making 10px labels unreadable.
          boardHeight=840 matches the typical operator viewport aspect so
          fitViewBox centering offset y≈(840-836)/2≈2 — nearly zero dead space.
          See PanZoomSVG.tsx for the full implementation rationale.
        */}
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={840}
          ariaLabel="VSM-organ schematic of the whole Minsky system"
          className="flex-1"
        >
          <SvgDefs />
          <S5Canopy />
          <S4Future />
          <S1Operations readyCount={readyCount} readyLoading={readyLoading} />
          <S3Gauges />
          <AttentionSeam />
          <LearningLoop />
          <InfraSupply />
        </PanZoomSVG>

        {/* Legend sidebar — collapsible to preserve board width on narrow viewports */}
        <PlantLegend />
      </div>
    </div>
  );
}