/**
 * PlantPage — the "/plant" route.
 *
 * VSM-organ whole-system schematic ("living plant") — v1 slice (mt#2376),
 * pan/zoom (mt#2380), and densified composition (mt#2387).
 *
 * Composition (mt#2387): tight full-width horizontal bands stacked top→bottom —
 *   S5 identity strip → S3 gauge ROW → S1 process spine → S4 future strip →
 *   learning-loop strip → infra strip. The attention seam runs down the right
 *   margin from YOU to the S1 spine. No tall side-columns, no center void: every
 *   band uses the full width so the fit-view reads as a dense composed diagram
 *   rather than elements floating in black.
 *
 * One level wired to real data: READY tank count from GET /api/tasks (TanStack
 * Query). All other levels are clearly-labelled "—" placeholders.
 *
 * Idle-honesty is a hard constraint: only the 3★ scan sweep, the slow tank
 * breath, and the pending-ask pulse move; no event → no motion.
 *
 * Color discipline: semantic --vsm-* tokens only; no raw hex.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
// Layout constants — the band grid (board is BOARD_W × BOARD_H)
// ---------------------------------------------------------------------------

const BOARD_W = 1280;
const BOARD_H = 760;
const SEAM_X = 1150; // attention seam runs down the right margin
const PIPE_Y = 360; // S1 process-line pipe

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

function tankFill(count: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, count / max));
}

// ---------------------------------------------------------------------------
// S5 Identity strip (top band, full width)
// ---------------------------------------------------------------------------

function S5Canopy() {
  return (
    <g role="region" aria-label="S5 Identity — rules corpus and operator">
      <rect
        x="20" y="12" width="1240" height="50" rx="8"
        fill="oklch(var(--vsm-s5) / 0.04)"
        stroke="oklch(var(--vsm-s5) / 0.28)"
        strokeWidth="1"
      />
      <text x="34" y="34" fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fill="oklch(var(--vsm-s5) / 1)" fontFamily="var(--font-mono)">S5 · IDENTITY</text>
      <text x="34" y="52" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">rules corpus · decision-defaults · the operator</text>
      <text x="560" y="34" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">rules: — active</text>
      <text x="560" y="50" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">decision-defaults: — sections</text>
      {/* YOU node — operator terminus of attention seam (right margin) */}
      <circle
        cx={SEAM_X} cy="37" r="12"
        fill="oklch(var(--vsm-seam) / 0.22)"
        stroke="oklch(var(--vsm-seam) / 0.9)"
        filter="url(#seam-glow)"
      />
      <text x={SEAM_X + 20} y="41" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-seam) / 1)" fontFamily="var(--font-mono)">YOU</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// S3 Management + 3★ — horizontal gauge ROW (second band)
// ---------------------------------------------------------------------------

interface GaugeProps {
  cx: number;
  cy: number;
  label: string;
  sublabel: string;
  needleAngle: number;
  setpointAngle: number;
}

function Gauge({ cx, cy, label, sublabel, needleAngle, setpointAngle }: GaugeProps) {
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
      <path d={`M${cx - 46} ${cy} A46 46 0 0 1 ${cx + 46} ${cy}`} fill="none" stroke="oklch(var(--border) / 1)" strokeWidth="8"/>
      <line x1={sx1} y1={sy1} x2={sx2} y2={sy2} stroke="oklch(var(--warn-red) / 1)" strokeWidth="2"/>
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="oklch(var(--foreground) / 1)" strokeWidth="2"/>
      <text x={cx} y={cy + 22} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">{label}</text>
      <text x={cx} y={cy + 36} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">{sublabel}</text>
    </g>
  );
}

function S3Gauges() {
  const cy = 150;
  return (
    <g role="region" aria-label="S3 Management and 3-star — gauges with alarm setpoints">
      <text x="34" y="96" fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fill="oklch(var(--vsm-s3) / 1)" fontFamily="var(--font-mono)">S3 · 3★</text>
      <Gauge cx={360} cy={cy} label="mcp disconnect" sublabel="— / 24h (alarm 3)" needleAngle={-60} setpointAngle={60} />
      <Gauge cx={640} cy={cy} label="dispatch cadence" sublabel="— partial/sess (alarm 2)" needleAngle={-80} setpointAngle={45} />
      <Gauge cx={920} cy={cy} label="attention load" sublabel="—" needleAngle={-40} setpointAngle={20} />
      <text x="1070" y={cy + 4} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">3★ audit sweep</text>
      <text x="1070" y={cy + 18} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">⟶ over S1</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Ready tank (the ONE wired level) — straddles the S1 pipe
// ---------------------------------------------------------------------------

interface ReadyTankProps {
  count: number | undefined;
  isLoading: boolean;
}

function ReadyTank({ count, isLoading }: ReadyTankProps) {
  const fill = count !== undefined ? tankFill(count, 20) : 0;
  const tankH = 56;
  const tankY = PIPE_Y - tankH / 2; // straddle the pipe
  const fillH = Math.round(tankH * fill);
  const fillY = tankY + (tankH - fillH);
  const displayCount = isLoading ? "…" : (count ?? "—");

  return (
    <g role="img" aria-label={`READY tank: ${displayCount} tasks`}>
      <rect x="300" y={tankY} width="58" height={tankH} rx="5" fill="none" stroke="oklch(var(--vsm-s1) / 0.9)" strokeWidth="1"/>
      {fillH > 0 && (
        <rect x="302" y={fillY} width="54" height={fillH} rx="3" fill="oklch(var(--vsm-s1) / 0.40)" className="vsm-breath" aria-hidden="true"/>
      )}
      <text x="329" y={tankY - 6} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">READY</text>
      <text x="329" y={tankY + tankH + 16} textAnchor="middle" fontSize="11" fill="oklch(var(--vsm-s1) / 0.9)" fontFamily="var(--font-mono)" fontWeight="600">{displayCount}</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// S1 Operations — the process spine (third band, full width)
// ---------------------------------------------------------------------------

interface S1OperationsProps {
  readyCount: number | undefined;
  readyLoading: boolean;
}

function S1Operations({ readyCount, readyLoading }: S1OperationsProps) {
  const top = PIPE_Y - 70; // region top
  return (
    <g role="region" aria-label="S1 Operations — the main process line">
      <rect x="20" y={top} width="1240" height="150" rx="10" fill="oklch(var(--vsm-s1) / 0.04)" stroke="oklch(var(--vsm-s1) / 0.22)" strokeWidth="1"/>
      <text x="34" y={top + 20} fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fill="oklch(var(--vsm-s1) / 1)" fontFamily="var(--font-mono)">S1 · OPERATIONS</text>

      {/* Main pipe */}
      <path d={`M180 ${PIPE_Y} H1080`} stroke="oklch(var(--border) / 1)" strokeWidth="10" fill="none" strokeLinecap="round"/>
      <path className="vsm-scan" d={`M180 ${PIPE_Y} H1080`} stroke="oklch(var(--vsm-s1) / 0.5)" strokeWidth="3" fill="none" strokeDasharray="2 7"/>

      {/* Stage: TASKS */}
      <text x="200" y={PIPE_Y - 16} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">TASKS</text>
      <circle cx="200" cy={PIPE_Y} r="6" fill="oklch(var(--vsm-s1) / 1)"/>

      {/* READY tank — one real level */}
      <ReadyTank count={readyCount} isLoading={readyLoading} />

      {/* Stage: SESSIONS */}
      <text x="470" y={PIPE_Y - 16} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">SESSIONS</text>
      <circle cx="470" cy={PIPE_Y} r="7" fill="oklch(var(--vsm-s1) / 1)" filter="url(#s1-glow)"/>
      <text x="470" y={PIPE_Y + 50} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">— active</text>

      {/* Stage: AGENTS */}
      <text x="620" y={PIPE_Y - 16} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">AGENTS</text>
      <g fill="oklch(var(--vsm-s1) / 0.8)">
        <circle cx="606" cy={PIPE_Y} r="4"/>
        <circle cx="620" cy={PIPE_Y - 7} r="4"/>
        <circle cx="634" cy={PIPE_Y} r="4"/>
        <circle cx="620" cy={PIPE_Y + 7} r="4"/>
      </g>
      <text x="620" y={PIPE_Y + 50} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">— dispatched</text>

      {/* Stage: PR */}
      <text x="770" y={PIPE_Y - 16} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">PR</text>
      <circle cx="770" cy={PIPE_Y} r="6" fill="oklch(var(--vsm-s1) / 1)"/>

      {/* Review tank */}
      <rect x="850" y={PIPE_Y - 28} width="58" height="56" rx="5" fill="none" stroke="oklch(var(--vsm-s1) / 0.9)" strokeWidth="1"/>
      <rect x="852" y={PIPE_Y + 14} width="54" height="12" rx="3" fill="oklch(var(--vsm-s1) / 0.35)" className="vsm-breath"/>
      <text x="879" y={PIPE_Y - 34} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">REVIEW</text>
      <text x="879" y={PIPE_Y + 50} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">—</text>

      {/* CHANGES_REQUESTED recirculation arc — shallow, stays in-band */}
      <path d={`M879 ${PIPE_Y - 28} C879 ${PIPE_Y - 56}, 470 ${PIPE_Y - 56}, 470 ${PIPE_Y - 18}`} fill="none" stroke="oklch(var(--vsm-s1) / 0.4)" strokeDasharray="4 5" strokeWidth="1.5"/>
      <text x="675" y={PIPE_Y - 60} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">⟲ CHANGES_REQUESTED recirculates</text>

      {/* Stage: DONE */}
      <text x="1015" y={PIPE_Y - 16} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">DONE</text>
      <circle cx="1015" cy={PIPE_Y} r="7" fill="oklch(var(--liveness-healthy) / 1)"/>

      {/* S2 interlock valves (◇) on the pipe */}
      <g fill="oklch(var(--background) / 1)" stroke="oklch(var(--vsm-s2) / 1)" strokeWidth="1.5" aria-label="S2 interlock valves">
        <rect x="252" y={PIPE_Y - 8} width="16" height="16" transform={`rotate(45 260 ${PIPE_Y})`} role="img" aria-label="Interlock valve before READY"/>
        <rect x="412" y={PIPE_Y - 8} width="16" height="16" transform={`rotate(45 420 ${PIPE_Y})`} role="img" aria-label="Interlock valve before SESSIONS"/>
        <rect x="692" y={PIPE_Y - 8} width="16" height="16" transform={`rotate(45 700 ${PIPE_Y})`} role="img" aria-label="Interlock valve before PR"/>
        <rect x="952" y={PIPE_Y - 8} width="16" height="16" transform={`rotate(45 960 ${PIPE_Y})`} role="img" aria-label="Interlock valve before DONE"/>
      </g>
      <text x="640" y={top + 142} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-s2) / 0.9)" fontFamily="var(--font-mono)">◇ = S2 interlock (hook/guard) · flashes red=blocked / amber=override (v2)</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// S4 Future — horizontal strip (feed + deploy + knowledge)
// ---------------------------------------------------------------------------

function S4Future() {
  const top = 470;
  return (
    <g role="region" aria-label="S4 Future — roadmap feed and deploy loop">
      <text x="34" y={top} fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fill="oklch(var(--vsm-s4) / 1)" fontFamily="var(--font-mono)">S4 · FUTURE</text>

      {/* Backlog feed tank — right-sized, horizontal placement */}
      <rect x="34" y={top + 12} width="70" height="56" rx="6" fill="none" stroke="oklch(var(--vsm-s4) / 0.9)" strokeWidth="1"/>
      <rect x="36" y={top + 42} width="66" height="24" rx="4" fill="oklch(var(--vsm-s4) / 0.30)" className="vsm-breath"/>
      <text x="116" y={top + 26} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">backlog feed</text>
      <text x="116" y={top + 44} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">PLANNING — · TODO —</text>
      <text x="116" y={top + 62} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">knowledge sources ▸ —</text>

      {/* Deploy loop */}
      <text x="420" y={top + 26} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">deploy loop</text>
      <rect x="420" y={top + 34} width="240" height="32" rx="6" fill="none" stroke="oklch(var(--vsm-s4) / 0.50)" strokeWidth="1"/>
      <text x="432" y={top + 55} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">
        build → smoke → <tspan fill="oklch(var(--liveness-healthy) / 1)">live ✓</tspan>
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Learning loop — horizontal strip
// ---------------------------------------------------------------------------

function LearningLoop() {
  const top = 575;
  const flow = top + 28;
  return (
    <g role="region" aria-label="Learning loop — failure to retrospective to memory to rule to new interlock">
      <text x="34" y={top} fontSize="13" letterSpacing="0.12em" fontWeight="700" opacity="0.6" fill="oklch(var(--vsm-learn) / 1)" fontFamily="var(--font-mono)">LEARNING LOOP</text>
      <path d={`M200 ${flow} H980`} stroke="oklch(var(--vsm-learn) / 0.35)" strokeWidth="2" fill="none" strokeDasharray="2 6"/>
      <text x="200" y={flow - 6} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">failure</text>
      <text x="300" y={flow - 6} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">▸ retrospective</text>
      <rect x="450" y={flow - 16} width="120" height="32" rx="6" fill="none" stroke="oklch(var(--vsm-learn) / 1)" strokeWidth="1"/>
      <rect x="452" y={flow} width="116" height="14" rx="3" fill="oklch(var(--vsm-learn) / 0.30)" className="vsm-breath"/>
      <text x="510" y={flow - 22} textAnchor="middle" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">memory reservoir · —</text>
      <text x="600" y={flow - 6} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">▸ rule</text>
      <text x="680" y={flow - 6} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">▸ ⟂ new interlock welded onto S1 (glows, fades over days)</text>
      {/* Arc closing back up onto an S2 valve on the pipe */}
      <path d={`M960 ${flow - 16} C960 ${PIPE_Y + 90}, 960 ${PIPE_Y + 30}, 960 ${PIPE_Y + 10}`} fill="none" stroke="oklch(var(--vsm-learn) / 0.4)" strokeDasharray="2 5" strokeWidth="1.5"/>
      <text x="968" y={PIPE_Y + 120} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-learn) / 0.7)" fontFamily="var(--font-mono)">↑ closes onto an S2 valve</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Infra supply band (bottom strip)
// ---------------------------------------------------------------------------

function InfraSupply() {
  const top = 640;
  return (
    <g role="region" aria-label="Infrastructure supply band">
      <rect x="20" y={top} width="1240" height="100" rx="8" fill="none" stroke="oklch(var(--border) / 1)" strokeWidth="1"/>
      <text x="34" y={top + 20} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">INFRA SUPPLY</text>
      <text x="34" y={top + 42} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--liveness-healthy) / 1)" fontFamily="var(--font-mono)">● MCP server — —</text>
      <text x="34" y={top + 60} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">● Postgres — —</text>
      <text x="34" y={top + 78} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">● credentials — —</text>
      <text x="640" y={top + 42} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--muted-foreground) / 1)" fontFamily="var(--font-mono)">● embeddings — —</text>
      <text x="640" y={top + 60} fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-learn) / 0.8)" fontFamily="var(--font-mono)">reviewer bot — —</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Attention / Ask seam — runs down the right margin from YOU to the S1 spine
// ---------------------------------------------------------------------------

function AttentionSeam() {
  return (
    <g role="region" aria-label="Attention seam — cognition coupling between system and operator">
      <line x1={SEAM_X} y1="50" x2={SEAM_X} y2={PIPE_Y} stroke="oklch(var(--vsm-seam) / 0.6)" strokeWidth="2.5" strokeDasharray="3 4"/>
      <text x={SEAM_X + 12} y="210" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-seam) / 1)" fontFamily="var(--font-mono)">attention seam</text>
      <circle cx={SEAM_X} cy="240" r="6" fill="oklch(var(--vsm-seam) / 1)" filter="url(#seam-glow)" className="vsm-ask-pulse" aria-label="Pending ask"/>
      <text x={SEAM_X + 12} y="244" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-seam) / 1)" fontFamily="var(--font-mono)">ask pending ↑</text>
      <text x={SEAM_X + 12} y="280" fontSize="10" letterSpacing="0.05em" fill="oklch(var(--vsm-seam) / 0.65)" fontFamily="var(--font-mono)">decision ↓ unblocks</text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Legend sidebar (collapsible)
// ---------------------------------------------------------------------------

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 my-1 text-xs font-mono">
      <span className="flex-none w-3 h-3 rounded-sm" style={{ background: color }} aria-hidden="true"/>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function PlantLegend() {
  const [open, setOpen] = useState(true);
  return (
    <aside
      className={cn("border-l border-border bg-card flex-none flex flex-col transition-[width]", open ? "w-[200px]" : "w-[32px]")}
      aria-label="Plant board legend"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Collapse legend" : "Expand legend"}
        aria-expanded={open}
        className={cn(
          "flex items-center justify-center flex-none w-8 h-8 border-b border-border",
          "text-muted-foreground text-[10px] font-mono hover:bg-secondary hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open ? "self-end" : "self-center"
        )}
      >
        {open ? "›" : "‹"}
      </button>
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
// SVG defs (filters)
// ---------------------------------------------------------------------------

function SvgDefs() {
  return (
    <defs>
      <filter id="seam-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="s1-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
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
      className={cn("flex flex-col h-full bg-background text-foreground overflow-hidden", "vsm-plant-page")}
      data-testid="plant-page"
    >
      <header className="flex items-baseline gap-4 px-[18px] py-[10px] border-b border-border flex-none">
        <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">MINSKY · WHOLE-SYSTEM PLANT</h1>
        <span className="text-[11px] font-mono text-muted-foreground">
          v1 · READY tank live · all other levels placeholder · idle-honest
        </span>
        <span className="ml-auto text-[11px] font-mono text-liveness-healthy">● system nominal</span>
      </header>

      <div className="flex flex-1 min-h-0">
        {/*
          Densified composition (mt#2387): tight full-width horizontal bands —
          S5 strip → S3 gauge row → S1 spine → S4 strip → learning → infra — with
          the seam down the right margin. Board BOARD_W×BOARD_H; pan/zoom via
          PanZoomSVG (boardHeight threaded through).
        */}
        <PanZoomSVG
          boardWidth={BOARD_W}
          boardHeight={BOARD_H}
          ariaLabel="VSM-organ schematic of the whole Minsky system"
          className="flex-1"
        >
          <SvgDefs />
          <S5Canopy />
          <S3Gauges />
          <AttentionSeam />
          <S1Operations readyCount={readyCount} readyLoading={readyLoading} />
          <S4Future />
          <LearningLoop />
          <InfraSupply />
        </PanZoomSVG>

        <PlantLegend />
      </div>
    </div>
  );
}
