/**
 * PlantFlowPage — the "/plant-flow" route (mt#2389).
 *
 * A node-link canvas rearchitecture of the VSM-organ plant board, built as a
 * THIRD parallel route alongside /plant (SVG schematic) and /plant-grid (CSS grid)
 * for side-by-side comparison (ADR-020).
 *
 * Design rationale (from ADR-020, memory 82c7a58e):
 *   - SVG /plant: native flow + relational legibility BUT fixed-aspect letterbox ceiling.
 *   - CSS /plant-grid: responsive fill + density BUT loses continuous-flow substrate.
 *   - Node-link canvas (@xyflow/react): threads both needles — HTML node panels
 *     (density + reuse) wired by animated SVG edges (flow + relational legibility),
 *     on a pan/zoom canvas (responsive fill + spatial stability).
 *
 * HMI-bones / lush-skin stance (ADR-020 load-bearing principle):
 *   - Adopt ISA-101 High-Performance HMI INFORMATION ARCHITECTURE (node-link topology,
 *     embedded live data, overview → drill-down hierarchy, anomaly-pops).
 *   - KEEP the lush cyberbrain/Section-9 aesthetic. Reinterpret HMI's
 *     "grayscale at rest / color on alarm" as "coherent rich field at rest /
 *     deviation breaks the harmony."
 *
 * Architecture:
 *   - @xyflow/react (MIT, v12.11.0, 37k stars — gate-(k) PASSED).
 *   - Custom node types: organ panels with rich HTML interiors.
 *   - Semantic tokens only — no raw hex; VSM palette vars for organ colors.
 *   - useReadyCount shared hook — READY node shows live /api/tasks count.
 *   - Animated edges (preview v2 flow) — gated on prefers-reduced-motion via
 *     the global CSS rule in index.css (@media prefers-reduced-motion: reduce).
 *   - Fixed initial node positions; pan/zoom enabled (react-flow default).
 *
 * Deferred (v2):
 *   - Dagre/elk auto-layout for slow-clock topology derivation.
 *   - Real event-driven dot motion on edges (mt#2375 honest-motion law).
 *   - Per-organ drill-down routes (Shneiderman zoom-to-detail).
 */

import { useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  ReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useReadyCount } from "../hooks/useReadyCount";

// ---------------------------------------------------------------------------
// Node data types
// ---------------------------------------------------------------------------

interface OrganNodeData {
  organKey: string;
  label: string;
  sublabel: string;
  accentVar: string;
  children?: React.ReactNode;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Organ accent CSS variable helpers
// These match the VSM palette in index.css / tailwind.config.ts
// ---------------------------------------------------------------------------

const ORGAN_ACCENTS = {
  s5: "var(--vsm-s5)",
  s4: "var(--vsm-s4)",
  s3: "var(--vsm-s3)",
  s1: "var(--vsm-s1)",
  seam: "var(--vsm-seam)",
  learn: "var(--vsm-learn)",
  infra: "var(--border)",
} as const;

// ---------------------------------------------------------------------------
// Reusable sub-components used inside node panels
// ---------------------------------------------------------------------------

/** Compact mini gauge arc (SVG) — used inside the S3 node. */
function MiniGaugeArc({
  label,
  sublabel,
  needleFraction,
  setpointFraction,
}: {
  label: string;
  sublabel: string;
  needleFraction: number;
  setpointFraction: number;
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
      </figcaption>
    </figure>
  );
}

/** Tank fill level bar — used inside lifecycle stage nodes. */
function TankBar({
  label,
  count,
  max,
  isLoading,
  accentVar,
}: {
  label: string;
  count: number | undefined;
  max: number;
  isLoading: boolean;
  accentVar: string;
}) {
  const fill = count !== undefined ? Math.min(1, Math.max(0, count / max)) : 0;
  const displayCount = isLoading ? "…" : (count ?? "—");

  return (
    <div className="flex flex-col gap-1" aria-label={`${label} tank: ${displayCount}`}>
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-mono text-muted-foreground">{label}</span>
        <span
          className="text-[10px] font-mono font-semibold"
          style={{ color: `oklch(${accentVar} / 0.9)` }}
        >
          {displayCount}
        </span>
      </div>
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ background: `oklch(${accentVar} / 0.15)` }}
        aria-hidden="true"
      >
        <div
          className="h-full rounded-full vsm-breath transition-all duration-500"
          style={{
            width: `${fill * 100}%`,
            background: `oklch(${accentVar} / 0.55)`,
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Base OrganNode wrapper
// Provides the panel shell (border, accent stripe, label, handle positions).
// Organ-specific content is rendered as children inside the data prop.
// ---------------------------------------------------------------------------

interface OrganNodeInnerProps {
  accentVar: string;
  label: string;
  sublabel: string;
  children: React.ReactNode;
  handles?: Array<{ type: "source" | "target"; position: Position; id: string }>;
  "data-testid"?: string;
}

function OrganNodeShell({
  accentVar,
  label,
  sublabel,
  children,
  handles,
  "data-testid": dataTestId,
}: OrganNodeInnerProps) {
  return (
    <div
      className="relative rounded-md bg-card overflow-hidden text-foreground"
      style={{
        border: `1px solid oklch(${accentVar} / 0.30)`,
        minWidth: "160px",
        boxShadow: `0 0 16px -4px oklch(${accentVar} / 0.12)`,
      }}
      data-testid={dataTestId}
    >
      {/* Accent stripe at top */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px]"
        style={{ background: `oklch(${accentVar} / 0.55)` }}
        aria-hidden="true"
      />
      {/* Header */}
      <div className="flex items-baseline gap-2 px-3 pt-3 pb-1">
        <h2
          className="text-[10px] font-mono font-bold tracking-[0.12em] uppercase leading-none"
          style={{ color: `oklch(${accentVar} / 0.85)` }}
        >
          {label}
        </h2>
        {sublabel && (
          <span className="text-[9px] font-mono text-muted-foreground leading-none truncate">
            {sublabel}
          </span>
        )}
      </div>
      {/* Content */}
      <div className="px-3 pb-3">{children}</div>
      {/* Handles */}
      {handles?.map((h) => (
        <Handle
          key={h.id}
          type={h.type}
          position={h.position}
          id={h.id}
          style={{
            background: `oklch(${accentVar} / 0.7)`,
            border: `1px solid oklch(${accentVar} / 0.4)`,
            width: 8,
            height: 8,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// S5 Identity node — policy canopy at the top
// ---------------------------------------------------------------------------

function S5IdentityNode(_props: NodeProps<Node<OrganNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s5;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="S5 · Identity"
      sublabel="rules corpus · decision-defaults"
      data-testid="flow-node-s5-identity"
      handles={[{ type: "source", position: Position.Bottom, id: "s5-out" }]}
    >
      <div className="flex items-center gap-4 flex-wrap">
        <div className="text-[9px] font-mono text-muted-foreground">rules: active</div>
        <div className="text-[9px] font-mono text-muted-foreground">decision-defaults: active</div>
        <div
          className="ml-auto flex items-center justify-center w-6 h-6 rounded-full border vsm-ask-pulse text-[8px] font-mono font-bold"
          style={{
            borderColor: `oklch(var(--vsm-seam) / 0.9)`,
            color: `oklch(var(--vsm-seam) / 1)`,
            background: `oklch(var(--vsm-seam) / 0.12)`,
          }}
          aria-label="YOU — operator terminus"
        >
          YOU
        </div>
      </div>
    </OrganNodeShell>
  );
}

// ---------------------------------------------------------------------------
// S4 Future node — roadmap feed + deploy loop
// ---------------------------------------------------------------------------

function S4FutureNode(_props: NodeProps<Node<OrganNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s4;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="S4 · Future"
      sublabel="roadmap · deploy loop"
      data-testid="flow-node-s4-future"
      handles={[
        { type: "source", position: Position.Right, id: "s4-out" },
        { type: "target", position: Position.Top, id: "s4-in" },
      ]}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div
            className="w-4 rounded border overflow-hidden flex-none"
            style={{ height: "28px", borderColor: `oklch(${accentVar} / 0.6)` }}
            aria-label="Backlog feed tank"
          >
            <div
              className="w-full vsm-breath"
              style={{
                height: "40%",
                marginTop: "60%",
                background: `oklch(${accentVar} / 0.35)`,
              }}
              aria-hidden="true"
            />
          </div>
          <span className="text-[9px] font-mono text-muted-foreground">backlog feed</span>
        </div>
        <div
          className="rounded px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground"
          style={{ border: `1px solid oklch(${accentVar} / 0.3)` }}
        >
          build → smoke → <span style={{ color: "oklch(var(--liveness-healthy) / 1)" }}>live ✓</span>
        </div>
      </div>
    </OrganNodeShell>
  );
}

// ---------------------------------------------------------------------------
// S3 Management node — gauges with alarm setpoints
// ---------------------------------------------------------------------------

function S3ManagementNode(_props: NodeProps<Node<OrganNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s3;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="S3 · Management + 3★"
      sublabel="gauges with alarm setpoints"
      data-testid="flow-node-s3-management"
      handles={[
        { type: "target", position: Position.Left, id: "s3-in" },
        { type: "source", position: Position.Bottom, id: "s3-out" },
      ]}
    >
      <div className="flex items-start justify-around gap-1 py-1">
        <MiniGaugeArc
          label="mcp disc."
          sublabel="alarm 3/24h"
          needleFraction={0.15}
          setpointFraction={0.75}
        />
        <MiniGaugeArc
          label="dispatch"
          sublabel="alarm 2/sess"
          needleFraction={0.10}
          setpointFraction={0.65}
        />
        <MiniGaugeArc
          label="attention"
          sublabel="—"
          needleFraction={0.35}
          setpointFraction={0.55}
        />
      </div>
      <div className="text-[8px] font-mono text-muted-foreground text-center">
        3★ sweep → over S1
      </div>
    </OrganNodeShell>
  );
}

// ---------------------------------------------------------------------------
// S1 lifecycle stage nodes — TASKS, READY, SESSIONS, AGENTS, PR, REVIEW, DONE
// These are the main process line — each is a separate node connected by edges.
// ---------------------------------------------------------------------------

interface S1StageNodeData extends OrganNodeData {
  stage: string;
  readyCount?: number;
  readyLoading?: boolean;
}

function S1TasksNode(_props: NodeProps<Node<S1StageNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s1;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="TASKS"
      sublabel="source pool"
      data-testid="flow-node-tasks"
      handles={[{ type: "source", position: Position.Right, id: "tasks-out" }]}
    >
      <div className="text-[9px] font-mono text-muted-foreground">TODO · PLANNING · READY</div>
    </OrganNodeShell>
  );
}

function S1ReadyNode(props: NodeProps<Node<S1StageNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s1;
  const { readyCount, readyLoading } = props.data as S1StageNodeData;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="READY"
      sublabel="queue tank"
      data-testid="flow-node-ready"
      handles={[
        { type: "target", position: Position.Left, id: "ready-in" },
        { type: "source", position: Position.Right, id: "ready-out" },
      ]}
    >
      <TankBar
        label="queued"
        count={readyCount}
        max={20}
        isLoading={readyLoading ?? false}
        accentVar={accentVar}
      />
    </OrganNodeShell>
  );
}

function S1SessionsNode(_props: NodeProps<Node<S1StageNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s1;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="SESSIONS"
      sublabel="active workspaces"
      data-testid="flow-node-sessions"
      handles={[
        { type: "target", position: Position.Left, id: "sessions-in" },
        { type: "source", position: Position.Right, id: "sessions-out" },
        { type: "target", position: Position.Top, id: "sessions-recirc" },
      ]}
    >
      <div className="text-[9px] font-mono text-muted-foreground">— active</div>
    </OrganNodeShell>
  );
}

function S1AgentsNode(_props: NodeProps<Node<S1StageNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s1;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="AGENTS"
      sublabel="dispatched workers"
      data-testid="flow-node-agents"
      handles={[
        { type: "target", position: Position.Left, id: "agents-in" },
        { type: "source", position: Position.Right, id: "agents-out" },
      ]}
    >
      {/* Mini cluster of agent dots — visual texture */}
      <div className="flex items-center gap-1 py-0.5" aria-label="Agent cluster">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="w-2 h-2 rounded-full"
            style={{ background: `oklch(${ORGAN_ACCENTS.s1} / 0.65)` }}
            aria-hidden="true"
          />
        ))}
        <span className="text-[9px] font-mono text-muted-foreground ml-1">— dispatched</span>
      </div>
    </OrganNodeShell>
  );
}

function S1PRNode(_props: NodeProps<Node<S1StageNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s1;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="PR"
      sublabel="pull request"
      data-testid="flow-node-pr"
      handles={[
        { type: "target", position: Position.Left, id: "pr-in" },
        { type: "source", position: Position.Right, id: "pr-out" },
      ]}
    >
      <div className="text-[9px] font-mono text-muted-foreground">open: —</div>
    </OrganNodeShell>
  );
}

function S1ReviewNode(_props: NodeProps<Node<S1StageNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s1;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="REVIEW"
      sublabel="review tank"
      data-testid="flow-node-review"
      handles={[
        { type: "target", position: Position.Left, id: "review-in" },
        { type: "source", position: Position.Right, id: "review-out" },
        { type: "source", position: Position.Top, id: "review-recirc" },
      ]}
    >
      <TankBar
        label="awaiting"
        count={undefined}
        max={10}
        isLoading={false}
        accentVar={accentVar}
      />
    </OrganNodeShell>
  );
}

function S1DoneNode(_props: NodeProps<Node<S1StageNodeData>>) {
  return (
    <OrganNodeShell
      accentVar="var(--liveness-healthy)"
      label="DONE"
      sublabel="completed"
      data-testid="flow-node-done"
      handles={[{ type: "target", position: Position.Left, id: "done-in" }]}
    >
      <div className="text-[9px] font-mono text-muted-foreground">merged: —</div>
    </OrganNodeShell>
  );
}

// ---------------------------------------------------------------------------
// Attention / Ask seam node
// ---------------------------------------------------------------------------

function AttentionSeamNode(_props: NodeProps<Node<OrganNodeData>>) {
  const accentVar = ORGAN_ACCENTS.seam;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="Attention · Ask Seam"
      sublabel="cognition coupling"
      data-testid="flow-node-attention-seam"
      handles={[
        { type: "target", position: Position.Bottom, id: "seam-in" },
        { type: "source", position: Position.Top, id: "seam-out" },
      ]}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center w-5 h-5 rounded-full vsm-ask-pulse text-[8px] font-mono font-bold"
            style={{
              background: `oklch(${accentVar} / 0.18)`,
              border: `1.5px solid oklch(${accentVar} / 0.7)`,
              color: `oklch(${accentVar} / 1)`,
            }}
            aria-label="Pending ask"
          >
            ↑
          </span>
          <span className="text-[9px] font-mono" style={{ color: `oklch(${accentVar} / 0.9)` }}>
            ask pending
          </span>
        </div>
        <div
          className="text-[8px] font-mono"
          style={{ color: `oklch(${accentVar} / 0.55)` }}
        >
          decision ↓ unblocks
        </div>
        <div className="text-[8px] font-mono text-muted-foreground">asks open: —</div>
      </div>
    </OrganNodeShell>
  );
}

// ---------------------------------------------------------------------------
// Learning loop node
// ---------------------------------------------------------------------------

function LearningLoopNode(_props: NodeProps<Node<OrganNodeData>>) {
  const accentVar = ORGAN_ACCENTS.learn;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="Learning Loop"
      sublabel="failure → rule → interlock"
      data-testid="flow-node-learning-loop"
      handles={[
        { type: "target", position: Position.Left, id: "learn-in" },
        { type: "source", position: Position.Right, id: "learn-out" },
      ]}
    >
      <div className="flex items-center gap-1 flex-wrap text-[9px] font-mono text-muted-foreground">
        <span>failure</span>
        <span className="text-muted-foreground/40">▸</span>
        <span>retro</span>
        <span className="text-muted-foreground/40">▸</span>
        <span
          className="px-1 py-0.5 rounded border vsm-breath"
          style={{
            borderColor: `oklch(${accentVar} / 0.6)`,
            color: `oklch(${accentVar} / 0.9)`,
          }}
        >
          memory
        </span>
        <span className="text-muted-foreground/40">▸</span>
        <span style={{ color: `oklch(${accentVar} / 0.7)` }}>⟂ interlock</span>
      </div>
    </OrganNodeShell>
  );
}

// ---------------------------------------------------------------------------
// Infra Supply node — supply band
// ---------------------------------------------------------------------------

function InfraSupplyNode(_props: NodeProps<Node<OrganNodeData>>) {
  const accentVar = ORGAN_ACCENTS.infra;
  const services = [
    { name: "MCP server", healthy: true },
    { name: "Postgres", healthy: true },
    { name: "credentials", healthy: false },
    { name: "embeddings", healthy: false },
    { name: "reviewer bot", healthy: false },
  ];

  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="Infra Supply"
      sublabel="supply chain for the plant"
      data-testid="flow-node-infra-supply"
      handles={[{ type: "source", position: Position.Top, id: "infra-out" }]}
    >
      <div className="flex items-center gap-3 flex-wrap">
        {services.map((s) => (
          <div key={s.name} className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: s.healthy
                  ? "oklch(var(--liveness-healthy) / 1)"
                  : "oklch(var(--muted-foreground) / 0.5)",
              }}
              aria-hidden="true"
            />
            <span className="text-[9px] font-mono text-muted-foreground">{s.name}</span>
          </div>
        ))}
      </div>
    </OrganNodeShell>
  );
}

// ---------------------------------------------------------------------------
// Node type registry — maps type strings to components
// ---------------------------------------------------------------------------

const nodeTypes = {
  "s5-identity": S5IdentityNode,
  "s4-future": S4FutureNode,
  "s3-management": S3ManagementNode,
  "s1-tasks": S1TasksNode,
  "s1-ready": S1ReadyNode,
  "s1-sessions": S1SessionsNode,
  "s1-agents": S1AgentsNode,
  "s1-pr": S1PRNode,
  "s1-review": S1ReviewNode,
  "s1-done": S1DoneNode,
  "attention-seam": AttentionSeamNode,
  "learning-loop": LearningLoopNode,
  "infra-supply": InfraSupplyNode,
} as const;

// ---------------------------------------------------------------------------
// Initial node positions — fixed layout encoding the VSM topology
//
// Layout design (high-level):
//   Row 0 (y=20):  S5 Identity (top center — policy canopy)
//   Row 1 (y=150): S4 Future (left) | S3 Management (right)
//   Row 2 (y=280): S1 lifecycle spine — TASKS → READY → SESSIONS → AGENTS → PR → REVIEW → DONE
//   Row 3 (y=420): Attention Seam (center) | Learning Loop (right)
//   Row 4 (y=540): Infra Supply (center bottom)
//
// x-coordinates align stages across the spine for readability.
// ---------------------------------------------------------------------------

const SPINE_Y = 295;
const SPINE_SPACING = 175;
const SPINE_START_X = 60;

function buildInitialNodes(readyCount: number | undefined, readyLoading: boolean): Node[] {
  return [
    // S5 Identity — top center
    {
      id: "s5-identity",
      type: "s5-identity",
      position: { x: 480, y: 20 },
      data: { organKey: "s5", label: "S5 · Identity", sublabel: "", accentVar: ORGAN_ACCENTS.s5 },
      draggable: true,
    },

    // S4 Future — upper left
    {
      id: "s4-future",
      type: "s4-future",
      position: { x: 40, y: 150 },
      data: { organKey: "s4", label: "S4 · Future", sublabel: "", accentVar: ORGAN_ACCENTS.s4 },
      draggable: true,
    },

    // S3 Management — upper right
    {
      id: "s3-management",
      type: "s3-management",
      position: { x: 900, y: 150 },
      data: { organKey: "s3", label: "S3 · Management", sublabel: "", accentVar: ORGAN_ACCENTS.s3 },
      draggable: true,
    },

    // S1 lifecycle spine — left to right
    {
      id: "s1-tasks",
      type: "s1-tasks",
      position: { x: SPINE_START_X, y: SPINE_Y },
      data: { organKey: "s1", label: "TASKS", sublabel: "", accentVar: ORGAN_ACCENTS.s1, stage: "tasks" },
      draggable: true,
    },
    {
      id: "s1-ready",
      type: "s1-ready",
      position: { x: SPINE_START_X + SPINE_SPACING * 1, y: SPINE_Y },
      data: {
        organKey: "s1",
        label: "READY",
        sublabel: "",
        accentVar: ORGAN_ACCENTS.s1,
        stage: "ready",
        readyCount,
        readyLoading,
      } as S1StageNodeData,
      draggable: true,
    },
    {
      id: "s1-sessions",
      type: "s1-sessions",
      position: { x: SPINE_START_X + SPINE_SPACING * 2, y: SPINE_Y },
      data: { organKey: "s1", label: "SESSIONS", sublabel: "", accentVar: ORGAN_ACCENTS.s1, stage: "sessions" },
      draggable: true,
    },
    {
      id: "s1-agents",
      type: "s1-agents",
      position: { x: SPINE_START_X + SPINE_SPACING * 3, y: SPINE_Y },
      data: { organKey: "s1", label: "AGENTS", sublabel: "", accentVar: ORGAN_ACCENTS.s1, stage: "agents" },
      draggable: true,
    },
    {
      id: "s1-pr",
      type: "s1-pr",
      position: { x: SPINE_START_X + SPINE_SPACING * 4, y: SPINE_Y },
      data: { organKey: "s1", label: "PR", sublabel: "", accentVar: ORGAN_ACCENTS.s1, stage: "pr" },
      draggable: true,
    },
    {
      id: "s1-review",
      type: "s1-review",
      position: { x: SPINE_START_X + SPINE_SPACING * 5, y: SPINE_Y },
      data: { organKey: "s1", label: "REVIEW", sublabel: "", accentVar: ORGAN_ACCENTS.s1, stage: "review" },
      draggable: true,
    },
    {
      id: "s1-done",
      type: "s1-done",
      position: { x: SPINE_START_X + SPINE_SPACING * 6, y: SPINE_Y },
      data: { organKey: "s1", label: "DONE", sublabel: "", accentVar: ORGAN_ACCENTS.s1, stage: "done" },
      draggable: true,
    },

    // Attention / Ask seam — below spine, center
    {
      id: "attention-seam",
      type: "attention-seam",
      position: { x: 480, y: 430 },
      data: { organKey: "seam", label: "Attention · Ask Seam", sublabel: "", accentVar: ORGAN_ACCENTS.seam },
      draggable: true,
    },

    // Learning loop — below spine, right
    {
      id: "learning-loop",
      type: "learning-loop",
      position: { x: 820, y: 430 },
      data: { organKey: "learn", label: "Learning Loop", sublabel: "", accentVar: ORGAN_ACCENTS.learn },
      draggable: true,
    },

    // Infra Supply — bottom center
    {
      id: "infra-supply",
      type: "infra-supply",
      position: { x: 260, y: 555 },
      data: { organKey: "infra", label: "Infra Supply", sublabel: "", accentVar: ORGAN_ACCENTS.infra },
      draggable: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Initial edges — the plant topology (pipes + seam + recirc + weld)
// animated: true on key flow edges previews v2 dot-motion
// (the global prefers-reduced-motion CSS rule in index.css disables animation
//  when the user has opted into reduced motion)
// ---------------------------------------------------------------------------

const INITIAL_EDGES: Edge[] = [
  // S5 → S1 Operations (policy governs the work process)
  {
    id: "s5-to-s1",
    source: "s5-identity",
    sourceHandle: "s5-out",
    target: "s1-tasks",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-s5) / 0.35)`, strokeDasharray: "4 6" },
    label: "governs",
    labelStyle: { fontSize: 9, fill: "oklch(var(--vsm-s5) / 0.55)" },
  },

  // S4 → S1 Tasks (roadmap feeds the task pool)
  {
    id: "s4-to-tasks",
    source: "s4-future",
    sourceHandle: "s4-out",
    target: "s1-tasks",
    type: "smoothstep",
    animated: true,
    style: { stroke: `oklch(var(--vsm-s4) / 0.55)` },
    label: "feeds",
    labelStyle: { fontSize: 9, fill: "oklch(var(--vsm-s4) / 0.65)" },
  },

  // S1 spine main flow (left to right)
  {
    id: "tasks-to-ready",
    source: "s1-tasks",
    sourceHandle: "tasks-out",
    target: "s1-ready",
    targetHandle: "ready-in",
    type: "smoothstep",
    animated: true,
    style: { stroke: `oklch(var(--vsm-s1) / 0.75)`, strokeWidth: 2 },
  },
  {
    id: "ready-to-sessions",
    source: "s1-ready",
    sourceHandle: "ready-out",
    target: "s1-sessions",
    targetHandle: "sessions-in",
    type: "smoothstep",
    animated: true,
    style: { stroke: `oklch(var(--vsm-s1) / 0.75)`, strokeWidth: 2 },
  },
  {
    id: "sessions-to-agents",
    source: "s1-sessions",
    sourceHandle: "sessions-out",
    target: "s1-agents",
    targetHandle: "agents-in",
    type: "smoothstep",
    animated: true,
    style: { stroke: `oklch(var(--vsm-s1) / 0.75)`, strokeWidth: 2 },
  },
  {
    id: "agents-to-pr",
    source: "s1-agents",
    sourceHandle: "agents-out",
    target: "s1-pr",
    targetHandle: "pr-in",
    type: "smoothstep",
    animated: true,
    style: { stroke: `oklch(var(--vsm-s1) / 0.75)`, strokeWidth: 2 },
  },
  {
    id: "pr-to-review",
    source: "s1-pr",
    sourceHandle: "pr-out",
    target: "s1-review",
    targetHandle: "review-in",
    type: "smoothstep",
    animated: true,
    style: { stroke: `oklch(var(--vsm-s1) / 0.75)`, strokeWidth: 2 },
  },
  {
    id: "review-to-done",
    source: "s1-review",
    sourceHandle: "review-out",
    target: "s1-done",
    targetHandle: "done-in",
    type: "smoothstep",
    animated: true,
    style: { stroke: `oklch(var(--vsm-s1) / 0.75)`, strokeWidth: 2 },
  },

  // CHANGES_REQUESTED recirculation loop: REVIEW → SESSIONS
  {
    id: "recirc",
    source: "s1-review",
    sourceHandle: "review-recirc",
    target: "s1-sessions",
    targetHandle: "sessions-recirc",
    type: "smoothstep",
    style: {
      stroke: `oklch(var(--vsm-s1) / 0.38)`,
      strokeDasharray: "4 6",
    },
    label: "⟲ CHANGES_REQUESTED",
    labelStyle: { fontSize: 8, fill: "oklch(var(--muted-foreground) / 0.65)" },
  },

  // S3 → S1 (management instruments the operations pipe)
  {
    id: "s3-to-s1",
    source: "s3-management",
    sourceHandle: "s3-out",
    target: "s1-agents",
    targetHandle: "agents-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-s3) / 0.35)`, strokeDasharray: "3 5" },
    label: "monitors",
    labelStyle: { fontSize: 9, fill: "oklch(var(--vsm-s3) / 0.55)" },
  },

  // Attention seam: S1 → Seam → S5 (ask rises to operator, decision flows back)
  {
    id: "s1-to-seam",
    source: "s1-sessions",
    sourceHandle: "sessions-out",
    target: "attention-seam",
    targetHandle: "seam-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-seam) / 0.45)`, strokeDasharray: "3 5" },
    label: "ask ↑",
    labelStyle: { fontSize: 9, fill: "oklch(var(--vsm-seam) / 0.65)" },
  },
  {
    id: "seam-to-s5",
    source: "attention-seam",
    sourceHandle: "seam-out",
    target: "s5-identity",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-seam) / 0.55)` },
    label: "decision ↓",
    labelStyle: { fontSize: 9, fill: "oklch(var(--vsm-seam) / 0.75)" },
  },

  // Learning loop weld: failure in sessions/agents → learn → back to S1 (new interlock)
  {
    id: "s1-to-learn",
    source: "s1-agents",
    sourceHandle: "agents-out",
    target: "learning-loop",
    targetHandle: "learn-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-learn) / 0.40)`, strokeDasharray: "3 5" },
    label: "failure",
    labelStyle: { fontSize: 9, fill: "oklch(var(--vsm-learn) / 0.55)" },
  },
  {
    id: "learn-to-s1",
    source: "learning-loop",
    sourceHandle: "learn-out",
    target: "s1-sessions",
    targetHandle: "sessions-recirc",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-learn) / 0.55)` },
    label: "⟂ new interlock",
    labelStyle: { fontSize: 9, fill: "oklch(var(--vsm-learn) / 0.7)" },
  },

  // Infra Supply → S1 (infra powers the operations pipe)
  {
    id: "infra-to-s1",
    source: "infra-supply",
    sourceHandle: "infra-out",
    target: "s1-sessions",
    targetHandle: "sessions-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--border) / 0.5)`, strokeDasharray: "2 6" },
    label: "powers",
    labelStyle: { fontSize: 9, fill: "oklch(var(--muted-foreground) / 0.45)" },
  },
];

// ---------------------------------------------------------------------------
// Main: PlantFlowCanvas (inner — needs ReactFlowProvider)
// ---------------------------------------------------------------------------

function PlantFlowCanvas() {
  const { data: readyCount, isLoading: readyLoading } = useReadyCount();

  // Build the initial node layout with placeholder ready data.
  // Live readyCount is propagated into the READY node via `updatedNodes` below,
  // so the layout is only built once (stable memo) without layout-resetting side effects.
  const initialNodes = buildInitialNodes(undefined, false);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(INITIAL_EDGES);

  // Propagate live readyCount into the READY node data without resetting layout.
  const updatedNodes = useMemo(() => {
    return nodes.map((node) => {
      if (node.id === "s1-ready") {
        return {
          ...node,
          data: { ...node.data, readyCount, readyLoading },
        };
      }
      return node;
    });
  }, [nodes, readyCount, readyLoading]);

  const onNodesChangeCallback = useCallback(onNodesChange, [onNodesChange]);
  const onEdgesChangeCallback = useCallback(onEdgesChange, [onEdgesChange]);

  return (
    <ReactFlow
      nodes={updatedNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChangeCallback}
      onEdgesChange={onEdgesChangeCallback}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      minZoom={0.3}
      maxZoom={2}
      defaultEdgeOptions={{
        style: { stroke: "oklch(var(--border) / 0.7)" },
      }}
      proOptions={{ hideAttribution: true }}
      style={{ background: "oklch(var(--background) / 1)" }}
      aria-label="Minsky plant flow diagram — VSM organs as connected nodes"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={24}
        size={1}
        color="oklch(var(--border) / 0.4)"
      />
    </ReactFlow>
  );
}

// ---------------------------------------------------------------------------
// Main: PlantFlowPage
// ---------------------------------------------------------------------------

export function PlantFlowPage() {
  return (
    <div
      className="flex flex-col h-screen bg-background text-foreground overflow-hidden"
      data-testid="plant-flow-page"
    >
      {/* Header */}
      <header className="flex items-baseline gap-4 px-[18px] py-[10px] border-b border-border flex-none">
        <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">
          MINSKY · PLANT FLOW
        </h1>
        <span className="text-[11px] font-mono text-muted-foreground">
          v1 · node-link canvas · READY tank live · pan/zoom · animated edges (v2 preview)
        </span>
        <span className="ml-auto flex items-center gap-3 text-[11px] font-mono">
          <span className="text-liveness-healthy">● system nominal</span>
          {/* Cross-links to the other plant board routes */}
          <Link
            to="/plant"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Switch to SVG schematic layout"
          >
            ▢ schematic
          </Link>
          <Link
            to="/plant-grid"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Switch to panel-grid layout"
          >
            ⊞ grid
          </Link>
        </span>
      </header>

      {/* React Flow canvas — fills the remaining height */}
      <div className="flex-1 min-h-0 relative" data-testid="plant-flow-canvas">
        <div className="absolute inset-0">
          <ReactFlowProvider>
            <PlantFlowCanvas />
          </ReactFlowProvider>
        </div>
      </div>
    </div>
  );
}