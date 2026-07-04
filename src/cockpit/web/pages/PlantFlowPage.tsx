/* eslint-disable max-lines -- tracked by mt#2598 */
/**
 * PlantFlowPage — the "/plant" route: the cockpit's whole-system plant board.
 *
 * A node-link canvas rendering of the VSM-organ plant (ADR-020, Accepted).
 * Originally built as a third parallel route alongside the SVG schematic and
 * CSS panel-grid prototypes; the substrate convergence (mt#2423) picked this
 * board and retired the other two (their sources live in git history —
 * instrument-parity port tracked in mt#2466).
 *
 * Design rationale (from ADR-020, memory 82c7a58e):
 *   - SVG schematic: native flow + relational legibility BUT fixed-aspect letterbox ceiling.
 *   - CSS panel grid: responsive fill + density BUT loses continuous-flow substrate.
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
 * Deferred:
 *   - Dagre/elk auto-layout for slow-clock topology derivation (v3).
 *   - Per-organ drill-down routes (Shneiderman zoom-to-detail) (v3).
 *   - Valve-flash / weld / reservoir-glow / deploy-pipe gestures — need the
 *     mt#2481 event types + emit wiring.
 *
 * v2.0 (mt#2377): event-driven fast-clock motion. Gestures (spine dots, node
 * pulses, edge flashes) fire ONLY from real system_events rows polled via
 * /api/activity — see lib/plant-gestures.ts for the fixed dictionary and the
 * honest-motion law. The always-on edge dash-marching from v1 was REMOVED:
 * idle must read calm.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  Background,
  BackgroundVariant,
  Panel,
  useNodesState,
  useEdgesState,
  useNodesInitialized,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useReadyCount } from "../hooks/useReadyCount";
import { useSystemEvents } from "../hooks/useSystemEvents";
import { useOpenAskCount } from "../hooks/useOpenAskCount";
import { useTaskBacklogCounts } from "../hooks/useTaskBacklogCounts";
import { useS3Gauges, gaugeFraction, GAUGE_SETPOINT_FRACTION } from "../hooks/useS3Gauges";
import { useSystemHealth, type ServiceHealth } from "../hooks/useSystemHealth";
import { GestureEdge } from "../components/GestureEdge";
import {
  GESTURE_MS,
  GESTURE_TONE_VARS,
  createGestureEngineState,
  mapEventToGestures,
  takeNewEvents,
} from "../lib/plant-gestures";

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
  s2: "var(--vsm-s2)",
  s1: "var(--vsm-s1)",
  seam: "var(--vsm-seam)",
  learn: "var(--vsm-learn)",
  infra: "var(--muted-foreground)",
} as const;

// ---------------------------------------------------------------------------
// Edge label style helpers — dark-theme-native, no white chip
// ---------------------------------------------------------------------------

/** Base label style for edge text — uses card background, no white chip */
const EDGE_LABEL_BG_STYLE = {
  fill: "oklch(var(--card) / 0.9)",
  fillOpacity: 1,
  rx: 3,
  ry: 3,
} as const;

/** Returns per-edge-type label style objects */
function edgeLabelStyle(colorVar: string, fontSize = 9): React.CSSProperties {
  return { fontSize, fill: `oklch(${colorVar} / 0.85)`, fontFamily: "var(--font-mono)" };
}

// ---------------------------------------------------------------------------
// Reusable sub-components used inside node panels
// ---------------------------------------------------------------------------

/** Compact mini gauge arc (SVG) — used inside the S3 node. */
function MiniGaugeArc({
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
function VesselTank({
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
  handles?: Array<{
    type: "source" | "target";
    position: Position;
    id: string;
    style?: React.CSSProperties;
  }>;
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
      {/* Handles — invisible dots; edges use them for routing only */}
      {handles?.map((h) => (
        <Handle
          key={h.id}
          type={h.type}
          position={h.position}
          id={h.id}
          isConnectable={false}
          style={{ opacity: 0, width: 8, height: 8, ...h.style }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// S5 Identity node — policy canopy at the top
// ---------------------------------------------------------------------------

interface S5IdentityNodeData extends OrganNodeData {
  openAskCount?: number | null;
}

function S5IdentityNode(props: NodeProps<Node<S5IdentityNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s5;
  const { openAskCount } = props.data as S5IdentityNodeData;
  const hasPendingAsk = (openAskCount ?? 0) > 0;
  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="S5 · Identity"
      sublabel="rules corpus · decision-defaults"
      data-testid="flow-node-s5-identity"
      handles={[
        { type: "source", position: Position.Bottom, id: "s5-out" },
        { type: "target", position: Position.Left, id: "s5-in" },
      ]}
    >
      <div className="flex items-center gap-4 flex-wrap">
        {/* STABLE-tier identity labeling (policy corpus presence), not a live
            telemetry claim — no numeric/measured value is asserted here, so
            it is not in scope for mt#2590's fake-live-data fix. */}
        <div className="text-[9px] font-mono text-muted-foreground">rules: active</div>
        <div className="text-[9px] font-mono text-muted-foreground">decision-defaults: active</div>
        <div
          className={[
            "ml-auto flex items-center justify-center w-6 h-6 rounded-full border text-[8px] font-mono font-bold",
            hasPendingAsk ? "vsm-ask-pulse" : undefined,
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            borderColor: `oklch(var(--vsm-seam) / 0.9)`,
            color: `oklch(var(--vsm-seam) / 1)`,
            background: `oklch(var(--vsm-seam) / 0.12)`,
          }}
          aria-label="YOU — operator terminus"
          data-testid="you-badge"
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

/** Backlog tank display scale — TODO+PLANNING count at/above this reads as "full". */
const BACKLOG_TANK_MAX = 30;

interface S4FutureNodeData extends OrganNodeData {
  todoCount?: number;
  planningCount?: number;
  backlogLoading?: boolean;
  backlogError?: boolean;
  deployStatus?: string | null;
}

function S4FutureNode(props: NodeProps<Node<S4FutureNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s4;
  const { todoCount, planningCount, backlogLoading, backlogError, deployStatus } =
    props.data as S4FutureNodeData;

  const backlogTotal =
    todoCount !== undefined && planningCount !== undefined ? todoCount + planningCount : undefined;
  const fill = backlogTotal !== undefined ? Math.min(1, backlogTotal / BACKLOG_TANK_MAX) : 0;
  const fillPct = Math.round(fill * 100);

  const planningLabel = backlogLoading ? "…" : backlogError || planningCount === undefined ? "—" : String(planningCount);
  const todoLabel = backlogLoading ? "…" : backlogError || todoCount === undefined ? "—" : String(todoCount);

  // Deploy chip: reuses the mcp-server-status widget's already-computed
  // deploy.status (no new endpoint — mt#2590 constraint 2). null means the
  // status is genuinely unreachable — render the honest placeholder rather
  // than the permanently-green claim this chip used to make.
  let deployNode: React.ReactNode;
  if (deployStatus === "SUCCESS") {
    deployNode = (
      <>
        build → smoke → <span style={{ color: "oklch(var(--liveness-healthy) / 1)" }}>live ✓</span>
      </>
    );
  } else if (deployStatus) {
    deployNode = (
      <span style={{ color: "oklch(var(--warn-amber) / 1)" }}>deploy: {deployStatus}</span>
    );
  } else {
    deployNode = <span className="text-muted-foreground">deploy: —</span>;
  }

  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="S4 · Future"
      sublabel="roadmap · deploy loop"
      data-testid="flow-node-s4-future"
      handles={[
        { type: "source", position: Position.Bottom, id: "s4-out" },
        { type: "target", position: Position.Top, id: "s4-in" },
      ]}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <div
            className="w-4 rounded border overflow-hidden flex-none"
            style={{ height: "40px", borderColor: `oklch(${accentVar} / 0.6)` }}
            aria-label="Backlog feed tank"
            data-testid="backlog-feed-tank"
          >
            <div
              className="w-full"
              style={{
                height: `${fillPct}%`,
                marginTop: `${100 - fillPct}%`,
                background: `oklch(${accentVar} / 0.35)`,
              }}
              aria-hidden="true"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] font-mono text-muted-foreground">backlog feed</span>
            <span className="text-[8px] font-mono text-muted-foreground/70">
              PLANNING {planningLabel} · TODO {todoLabel}
            </span>
          </div>
        </div>
        <div className="text-[8px] font-mono text-muted-foreground">knowledge sources ▸ —</div>
        <div
          className="rounded px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground"
          style={{ border: `1px solid oklch(${accentVar} / 0.3)` }}
          data-testid="s4-deploy-chip"
        >
          {deployNode}
        </div>
        {/* Mesh region — honestly-empty reserved placeholder (mt#2591; canon:
            mt#2375 §S4 "mesh region reserved/honestly-empty"). No data source
            exists for the mesh yet, so this carries NO numbers and NO
            animation — a dashed border + muted label is the whole contract. */}
        <div
          className="rounded px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground/60"
          style={{ border: `1px dashed oklch(${accentVar} / 0.35)` }}
          data-testid="s4-mesh-region"
          aria-label="Mesh region — reserved, not yet wired"
        >
          mesh — reserved
        </div>
      </div>
    </OrganNodeShell>
  );
}

// ---------------------------------------------------------------------------
// S3 Management node — gauges with alarm setpoints
// ---------------------------------------------------------------------------

interface S3ManagementNodeData extends OrganNodeData {
  mcpDisconnectCount?: number | null;
  mcpDisconnectThreshold?: number;
  dispatchCount?: number | null;
  dispatchThreshold?: number;
}

function S3ManagementNode(props: NodeProps<Node<S3ManagementNodeData>>) {
  const accentVar = ORGAN_ACCENTS.s3;
  const { mcpDisconnectCount, mcpDisconnectThreshold, dispatchCount, dispatchThreshold } =
    props.data as S3ManagementNodeData;

  const mcpThreshold = mcpDisconnectThreshold ?? 3;
  const dispThreshold = dispatchThreshold ?? 2;

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
          sublabel={`alarm ${mcpThreshold}/24h`}
          needleFraction={gaugeFraction(mcpDisconnectCount ?? null, mcpThreshold)}
          setpointFraction={GAUGE_SETPOINT_FRACTION}
          valueLabel={mcpDisconnectCount === null || mcpDisconnectCount === undefined ? "—" : String(mcpDisconnectCount)}
        />
        <MiniGaugeArc
          label="dispatch"
          sublabel={`alarm ${dispThreshold}/sess`}
          needleFraction={gaugeFraction(dispatchCount ?? null, dispThreshold)}
          setpointFraction={GAUGE_SETPOINT_FRACTION}
          valueLabel={dispatchCount === null || dispatchCount === undefined ? "—" : String(dispatchCount)}
        />
        {/* attention_report has no HTTP surface today (mt#2590 documented
            gap) — honest flat placeholder rather than a faked reading. */}
        <MiniGaugeArc
          label="attention"
          sublabel="—"
          needleFraction={0}
          setpointFraction={0}
          valueLabel="—"
        />
      </div>
      <div className="flex items-center justify-center gap-1.5">
        <span className="text-[8px] font-mono text-muted-foreground">3★ sweep → over S1</span>
        {/* The 3★ scan sweep — one of the two canon-allowed idle animations
            (memory 8d3d4f06). CSS-driven (not SVG SMIL) so the global
            prefers-reduced-motion rule in index.css gates it. */}
        <svg width="28" height="8" viewBox="0 0 28 8" aria-hidden="true" data-testid="vsm-scan-sweep">
          <line
            x1="1"
            y1="4"
            x2="27"
            y2="4"
            stroke={`oklch(${accentVar} / 0.7)`}
            strokeWidth="2"
            strokeDasharray="6 4"
            strokeLinecap="round"
            className="vsm-scan"
          />
        </svg>
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
      handles={[
        { type: "source", position: Position.Right, id: "tasks-out" },
        { type: "target", position: Position.Top, id: "tasks-in-top" },
        { type: "target", position: Position.Bottom, id: "tasks-power-in" },
      ]}
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
      <VesselTank
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
      sublabel="workspaces"
      data-testid="flow-node-sessions"
      handles={[
        { type: "target", position: Position.Left, id: "sessions-in" },
        { type: "source", position: Position.Right, id: "sessions-out" },
        { type: "target", position: Position.Top, id: "sessions-recirc" },
        { type: "source", position: Position.Bottom, id: "sessions-seam" },
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
      sublabel="workers"
      data-testid="flow-node-agents"
      handles={[
        { type: "target", position: Position.Left, id: "agents-in" },
        { type: "source", position: Position.Right, id: "agents-out" },
        { type: "target", position: Position.Top, id: "agents-monitor-in" },
        { type: "source", position: Position.Bottom, id: "agents-fail-out" },
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
      <VesselTank
        label="awaiting"
        count={undefined}
        max={10}
        isLoading={false}
        accentVar={accentVar}
        placeholder
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

interface AttentionSeamNodeData extends OrganNodeData {
  openAskCount?: number | null;
  openAskLoading?: boolean;
  openAskError?: boolean;
}

function AttentionSeamNode(props: NodeProps<Node<AttentionSeamNodeData>>) {
  const accentVar = ORGAN_ACCENTS.seam;
  const { openAskCount, openAskLoading, openAskError } = props.data as AttentionSeamNodeData;
  const hasPendingAsk = (openAskCount ?? 0) > 0;
  const asksOpenLabel = openAskLoading
    ? "…"
    : openAskError || openAskCount === undefined || openAskCount === null
      ? "—"
      : String(openAskCount);

  return (
    <OrganNodeShell
      accentVar={accentVar}
      label="Attention · Ask Seam"
      sublabel="cognition coupling"
      data-testid="flow-node-attention-seam"
      // Both seam handles sit on the TOP edge (offset apart): the ask rises
      // from SESSIONS into the seam's top-right; the decision exits top-left
      // toward S5. A bottom-side ask handle made the edge pass behind the
      // seam node itself (occluding its label) to wrap around underneath.
      handles={[
        { type: "target", position: Position.Top, id: "seam-in", style: { left: "70%" } },
        { type: "source", position: Position.Top, id: "seam-out", style: { left: "30%" } },
      ]}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span
            className={[
              "inline-flex items-center justify-center w-5 h-5 rounded-full text-[8px] font-mono font-bold",
              hasPendingAsk ? "vsm-ask-pulse" : undefined,
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              background: `oklch(${accentVar} / 0.18)`,
              border: `1.5px solid oklch(${accentVar} / 0.7)`,
              color: `oklch(${accentVar} / 1)`,
            }}
            aria-label="Pending ask"
            data-testid="seam-ask-badge"
          >
            ↑
          </span>
          <span className="text-[9px] font-mono" style={{ color: `oklch(${accentVar} / 0.9)` }}>
            {hasPendingAsk ? "ask pending" : "no ask pending"}
          </span>
        </div>
        <div
          className="text-[8px] font-mono"
          style={{ color: `oklch(${accentVar} / 0.55)` }}
        >
          decision ↓ unblocks
        </div>
        <div className="text-[8px] font-mono text-muted-foreground" data-testid="asks-open-count">
          asks open: {asksOpenLabel}
        </div>
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
      // Both learning edges route over the TOP (offset handles): the failure
      // inflow at 30%, the interlock outflow at 70% — keeping the node's right
      // flank clear of the bottom-right legend panel's viewport column.
      handles={[
        { type: "target", position: Position.Top, id: "learn-fail-in", style: { left: "30%" } },
        { type: "source", position: Position.Top, id: "learn-out", style: { left: "70%" } },
      ]}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1 flex-wrap text-[9px] font-mono text-muted-foreground">
          <span>failure</span>
          <span className="text-muted-foreground/40">▸</span>
          <span>retro</span>
          <span className="text-muted-foreground/40">▸</span>
          <span style={{ color: `oklch(${accentVar} / 0.9)` }}>memory</span>
          <span className="text-muted-foreground/40">▸</span>
          <span>rule</span>
          <span className="text-muted-foreground/40">▸</span>
          <span style={{ color: `oklch(${accentVar} / 0.7)` }}>⟂ interlock</span>
        </div>
        {/* Memory reservoir — the SVG board's tank instrument (mt#2466 item 4) */}
        <div
          className="flex items-center gap-2"
          aria-label="Memory reservoir"
          data-testid="memory-reservoir"
        >
          <svg width="46" height="20" viewBox="0 0 46 20" aria-hidden="true">
            <rect
              x="0.5"
              y="0.5"
              width="45"
              height="19"
              rx="4"
              fill="none"
              stroke={`oklch(${accentVar} / 0.9)`}
              strokeWidth="1"
            />
            <rect
              x="2"
              y="10"
              width="42"
              height="8"
              rx="2"
              fill={`oklch(${accentVar} / 0.3)`}
              className="vsm-breath"
            />
          </svg>
          <span className="text-[8px] font-mono text-muted-foreground">
            memory reservoir · —
          </span>
        </div>
      </div>
    </OrganNodeShell>
  );
}

// ---------------------------------------------------------------------------
// Infra Supply node — supply band
// ---------------------------------------------------------------------------

/** Dot color per real service-health state — "unknown" is the honest placeholder. */
function serviceDotColor(health: ServiceHealth | undefined): string {
  switch (health) {
    case "healthy":
      return "oklch(var(--liveness-healthy) / 1)";
    case "unhealthy":
      return "oklch(var(--warn-amber) / 1)";
    default:
      return "oklch(var(--muted-foreground) / 0.5)";
  }
}

interface InfraSupplyNodeData extends OrganNodeData {
  mcpServerHealth?: ServiceHealth;
  postgresHealth?: ServiceHealth;
  credentialsHealth?: ServiceHealth;
  embeddingsHealth?: ServiceHealth;
  reviewerBotHealth?: ServiceHealth;
}

function InfraSupplyNode(props: NodeProps<Node<InfraSupplyNodeData>>) {
  const accentVar = ORGAN_ACCENTS.infra;
  const {
    mcpServerHealth,
    postgresHealth,
    credentialsHealth,
    embeddingsHealth,
    reviewerBotHealth,
  } = props.data as InfraSupplyNodeData;

  const services: Array<{ name: string; health: ServiceHealth | undefined }> = [
    { name: "MCP server", health: mcpServerHealth },
    { name: "Postgres", health: postgresHealth },
    { name: "credentials", health: credentialsHealth },
    { name: "embeddings", health: embeddingsHealth },
    // No HTTP surface exists today for minsky-reviewer[bot] health from the
    // cockpit server (mt#2590 documented gap) — always renders the honest
    // "unknown" dot rather than a faked reading.
    { name: "reviewer bot", health: reviewerBotHealth ?? "unknown" },
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
          <div key={s.name} className="flex items-center gap-1.5" data-testid={`infra-dot-${s.name}`}>
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: serviceDotColor(s.health) }}
              data-testid={`infra-dot-status-${s.name}`}
              // Plain attribute mirror of the health state driving the dot
              // color, for test assertions — some CSS test environments
              // don't reliably serialize oklch()-valued inline color styles.
              data-health={s.health ?? "unknown"}
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
// S2 interlock valve node — the coordination organ (mt#2466 item 1)
// Small rotated-square valve glyphs that sit ON the spine pipe, ported from
// the SVG board. v2 will flash them red=blocked / amber=override on real
// guard events; in v1 they are the static organ presence.
// ---------------------------------------------------------------------------

interface S2ValveNodeData {
  valveKey: string;
  /** when true, exposes a bottom target handle (the learning-loop interlock weld) */
  interlockTarget?: boolean;
  [key: string]: unknown;
}

function S2ValveNode(props: NodeProps<Node<S2ValveNodeData>>) {
  const { valveKey, interlockTarget } = props.data as S2ValveNodeData;
  return (
    <div
      className="relative"
      style={{ width: 16, height: 16 }}
      data-testid={`flow-node-valve-${valveKey}`}
      aria-label={`S2 interlock valve before ${valveKey}`}
    >
      <div
        style={{
          width: 12,
          height: 12,
          margin: 2,
          transform: "rotate(45deg)",
          border: `1.5px solid oklch(${ORGAN_ACCENTS.s2} / 1)`,
          background: "oklch(var(--background) / 1)",
        }}
        aria-hidden="true"
      />
      {interlockTarget && (
        <Handle
          type="target"
          position={Position.Bottom}
          id="valve-in"
          isConnectable={false}
          style={{ opacity: 0, width: 6, height: 6 }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node type registry — maps type strings to components
// ---------------------------------------------------------------------------

const nodeTypes = {
  "s5-identity": S5IdentityNode,
  "s4-future": S4FutureNode,
  "s3-management": S3ManagementNode,
  "s2-valve": S2ValveNode,
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

/** Custom edge types — "gesture" renders the event-driven traveling dot. */
const edgeTypes = {
  gesture: GestureEdge,
} as const;

// ---------------------------------------------------------------------------
// Initial node positions — fixed layout encoding the VSM topology
//
// Layout design (mt#2466 instrument-parity pass, re-tuned for the sidebar
// shell: canvas ≈ 1200×805 at 1440×900, aspect ~1.49):
//   Row 0 (y=0):   S5 Identity (top, left-of-center)
//   Row 1 (y=160): S4 Future (left) | S3 Management (right)
//   Row 2 (y=400): S1 lifecycle spine + S2 interlock valves ON the pipe
//   Row 3 (y=550): Attention Seam (center-left) | Learning Loop (center-right)
//                  — at 550 (not lower) so the learning→valve interlock edge's
//                  smoothstep midpoint stays ABOVE the bottom-right legend panel
//   Row 4 (y=770): Infra Supply (bottom left) → bottom ≈ 840
//
// Bounding box ≈ 1276 × 840 (aspect ~1.5) — close to the post-sidebar canvas
// aspect, so fitView fills both axes. S5.x=402 puts the seam→S5 "decision ↓"
// approach channel (s5-in left handle, approach ≈ x-22 = 380) through the
// READY/SESSIONS spine gap — the one gap WITHOUT an S2 valve.
// Robustness: positions are a hint; the nodes-initialized refit effect below
// re-runs fitView with MEASURED node bounds, so nothing clips even if node
// heights drift from these estimates.
// ---------------------------------------------------------------------------

const SPINE_Y = 400;
const SPINE_SPACING = 182;
const SPINE_START_X = 30;
/** Vertical center of the spine pipe — valves sit on it. */
const VALVE_Y = 426;

function buildInitialNodes(readyCount: number | undefined, readyLoading: boolean): Node[] {
  return [
    // S5 Identity — top, left-of-center: x=402 puts the seam→S5 "decision ↓"
    // approach channel (s5-in left handle, approach ≈ x-22 = 380) through the
    // READY/SESSIONS spine gap (the valve-free gap).
    {
      id: "s5-identity",
      type: "s5-identity",
      position: { x: 402, y: 0 },
      data: { organKey: "s5", label: "S5 · Identity", sublabel: "", accentVar: ORGAN_ACCENTS.s5 },
      draggable: true,
    },

    // S4 Future — upper left (y aligned with S3)
    {
      id: "s4-future",
      type: "s4-future",
      position: { x: 30, y: 160 },
      data: { organKey: "s4", label: "S4 · Future", sublabel: "", accentVar: ORGAN_ACCENTS.s4 },
      draggable: true,
    },

    // S3 Management — upper right; bottom clears SPINE_Y=400
    {
      id: "s3-management",
      type: "s3-management",
      position: { x: 940, y: 160 },
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

    // Attention / Ask seam — below spine, center-left
    {
      id: "attention-seam",
      type: "attention-seam",
      position: { x: 420, y: 550 },
      data: { organKey: "seam", label: "Attention · Ask Seam", sublabel: "", accentVar: ORGAN_ACCENTS.seam },
      draggable: true,
    },

    // Learning loop — below spine, center-right; right edge clears the
    // bottom-right legend panel's viewport column
    {
      id: "learning-loop",
      type: "learning-loop",
      position: { x: 760, y: 550 },
      data: { organKey: "learn", label: "Learning Loop", sublabel: "", accentVar: ORGAN_ACCENTS.learn },
      draggable: true,
    },

    // Infra Supply — bottom left, clear of the seam's column so its supply
    // edge rises through the open left region
    {
      id: "infra-supply",
      type: "infra-supply",
      position: { x: 140, y: 770 },
      data: { organKey: "infra", label: "Infra Supply", sublabel: "", accentVar: ORGAN_ACCENTS.infra },
      draggable: true,
    },

    // S2 interlock valves — ON the spine pipe, in the gaps before READY,
    // AGENTS, PR, DONE (mt#2466 item 1). Not draggable: they are plumbing,
    // not panels. The DONE valve carries the learning-loop interlock target
    // (item 5 — "new interlock welds onto an S2 valve").
    {
      id: "s2-valve-ready",
      type: "s2-valve",
      position: { x: 190, y: VALVE_Y },
      data: { valveKey: "ready" },
      draggable: false,
      selectable: false,
    },
    {
      id: "s2-valve-agents",
      type: "s2-valve",
      position: { x: 554, y: VALVE_Y },
      data: { valveKey: "agents" },
      draggable: false,
      selectable: false,
    },
    {
      id: "s2-valve-pr",
      type: "s2-valve",
      position: { x: 736, y: VALVE_Y },
      data: { valveKey: "pr" },
      draggable: false,
      selectable: false,
    },
    {
      id: "s2-valve-done",
      type: "s2-valve",
      position: { x: 1090, y: VALVE_Y },
      data: { valveKey: "done", interlockTarget: true },
      draggable: false,
      selectable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Initial edges — the plant topology (pipes + seam + recirc + weld)
// No edge is permanently animated (honest-motion law): fast-clock motion is
// event-driven via the gesture engine (lib/plant-gestures.ts), which sets
// transient gesture data / classes when real system_events rows land.
// ---------------------------------------------------------------------------

const INITIAL_EDGES: Edge[] = [
  // S1 spine PIPE underlay — recreates the SVG board's 10px pipe body under
  // the teal flow dashes (mt#2466 item 2). Same handles as the flow edges so
  // the paths coincide exactly. MUST stay first in this array: react-flow
  // paints edges in array order, and an underlay that renders above any other
  // edge would occlude it at crossings.
  {
    id: "pipe-1",
    source: "s1-tasks",
    sourceHandle: "tasks-out",
    target: "s1-ready",
    targetHandle: "ready-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--border) / 1)`, strokeWidth: 5 },
  },
  {
    id: "pipe-2",
    source: "s1-ready",
    sourceHandle: "ready-out",
    target: "s1-sessions",
    targetHandle: "sessions-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--border) / 1)`, strokeWidth: 5 },
  },
  {
    id: "pipe-3",
    source: "s1-sessions",
    sourceHandle: "sessions-out",
    target: "s1-agents",
    targetHandle: "agents-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--border) / 1)`, strokeWidth: 5 },
  },
  {
    id: "pipe-4",
    source: "s1-agents",
    sourceHandle: "agents-out",
    target: "s1-pr",
    targetHandle: "pr-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--border) / 1)`, strokeWidth: 5 },
  },
  {
    id: "pipe-5",
    source: "s1-pr",
    sourceHandle: "pr-out",
    target: "s1-review",
    targetHandle: "review-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--border) / 1)`, strokeWidth: 5 },
  },
  {
    id: "pipe-6",
    source: "s1-review",
    sourceHandle: "review-out",
    target: "s1-done",
    targetHandle: "done-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--border) / 1)`, strokeWidth: 5 },
  },


  // S5 → S1 Operations (policy governs the work process).
  // Targets the SESSIONS top handle (where work executes) — routing to TASKS
  // would pass through the S4 node, which sits between S5 and the spine's left end.
  {
    id: "s5-to-s1",
    source: "s5-identity",
    sourceHandle: "s5-out",
    target: "s1-sessions",
    targetHandle: "sessions-recirc",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-s5) / 0.65)`, strokeDasharray: "4 6", strokeWidth: 1.5 },
    label: "governs",
    labelStyle: edgeLabelStyle("var(--vsm-s5)"),
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },

  // S4 → S1 Tasks (roadmap feeds the task pool).
  // S4 sits directly above TASKS — a clean vertical drop into the top handle.
  {
    id: "s4-to-tasks",
    source: "s4-future",
    sourceHandle: "s4-out",
    target: "s1-tasks",
    targetHandle: "tasks-in-top",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-s4) / 0.75)`, strokeWidth: 1.5 },
    label: "feeds",
    labelStyle: edgeLabelStyle("var(--vsm-s4)"),
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },

  // S1 spine main flow (left to right) — primary information channel, most
  // visible. Type "gesture": dots travel these edges ONLY when a real
  // system_events row fires (mt#2377 v2.0). The v1 always-on `animated` dash
  // marching was removed — fake busy-motion violates the honest-motion law.
  {
    id: "tasks-to-ready",
    source: "s1-tasks",
    sourceHandle: "tasks-out",
    target: "s1-ready",
    targetHandle: "ready-in",
    type: "gesture",
    style: { stroke: `oklch(var(--vsm-s1) / 1)`, strokeWidth: 2.5 },
  },
  {
    id: "ready-to-sessions",
    source: "s1-ready",
    sourceHandle: "ready-out",
    target: "s1-sessions",
    targetHandle: "sessions-in",
    type: "gesture",
    style: { stroke: `oklch(var(--vsm-s1) / 1)`, strokeWidth: 2.5 },
  },
  {
    id: "sessions-to-agents",
    source: "s1-sessions",
    sourceHandle: "sessions-out",
    target: "s1-agents",
    targetHandle: "agents-in",
    type: "gesture",
    style: { stroke: `oklch(var(--vsm-s1) / 1)`, strokeWidth: 2.5 },
  },
  {
    id: "agents-to-pr",
    source: "s1-agents",
    sourceHandle: "agents-out",
    target: "s1-pr",
    targetHandle: "pr-in",
    type: "gesture",
    style: { stroke: `oklch(var(--vsm-s1) / 1)`, strokeWidth: 2.5 },
  },
  {
    id: "pr-to-review",
    source: "s1-pr",
    sourceHandle: "pr-out",
    target: "s1-review",
    targetHandle: "review-in",
    type: "gesture",
    style: { stroke: `oklch(var(--vsm-s1) / 1)`, strokeWidth: 2.5 },
  },
  {
    id: "review-to-done",
    source: "s1-review",
    sourceHandle: "review-out",
    target: "s1-done",
    targetHandle: "done-in",
    type: "gesture",
    style: { stroke: `oklch(var(--vsm-s1) / 1)`, strokeWidth: 2.5 },
  },

  // CHANGES_REQUESTED recirculation loop: REVIEW → SESSIONS
  // Routes ABOVE the spine row (via the top handles) — arc up and back
  {
    id: "recirc",
    source: "s1-review",
    sourceHandle: "review-recirc",
    target: "s1-sessions",
    targetHandle: "sessions-recirc",
    type: "smoothstep",
    style: {
      stroke: `oklch(var(--warn-amber) / 0.75)`,
      strokeDasharray: "4 6",
      strokeWidth: 1.5,
    },
    label: "CHANGES_REQUESTED",
    labelStyle: edgeLabelStyle("var(--warn-amber)", 8),
    labelBgStyle: { ...EDGE_LABEL_BG_STYLE, fill: "oklch(var(--card) / 0.95)" },
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },

  // S3 → S1 (management instruments the operations pipe)
  {
    id: "s3-to-s1",
    source: "s3-management",
    sourceHandle: "s3-out",
    target: "s1-agents",
    targetHandle: "agents-monitor-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-s3) / 0.65)`, strokeDasharray: "3 5", strokeWidth: 1.5 },
    label: "monitors",
    labelStyle: edgeLabelStyle("var(--vsm-s3)"),
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },

  // Attention seam: S1 → Seam → S5 (ask rises to operator, decision flows back)
  // Use sessions bottom handle (no explicit sourceHandle) → ReactFlow routes optimally
  {
    id: "s1-to-seam",
    source: "s1-sessions",
    sourceHandle: "sessions-seam",
    target: "attention-seam",
    targetHandle: "seam-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-seam) / 0.8)`, strokeDasharray: "6 4", strokeWidth: 2.5 },
    label: "ask ↑",
    labelStyle: edgeLabelStyle("var(--vsm-seam)"),
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },
  {
    id: "seam-to-s5",
    source: "attention-seam",
    sourceHandle: "seam-out",
    target: "s5-identity",
    targetHandle: "s5-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-seam) / 0.8)`, strokeDasharray: "6 4", strokeWidth: 2.5 },
    label: "decision ↓",
    labelStyle: edgeLabelStyle("var(--vsm-seam)"),
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },

  // Learning loop: failure in agents → learn; learn outputs new interlock → S1 ops
  // Failure exits AGENTS' dedicated bottom handle and enters LEARNING's top —
  // through the empty band between the spine and the seam/learn row (not via
  // the shared spine handle, which made failure appear to originate from PR).
  {
    id: "s1-to-learn",
    source: "s1-agents",
    sourceHandle: "agents-fail-out",
    target: "learning-loop",
    targetHandle: "learn-fail-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-learn) / 0.65)`, strokeDasharray: "3 5", strokeWidth: 1.5 },
    label: "failure",
    labelStyle: edgeLabelStyle("var(--vsm-learn)"),
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },
  // learn-to-s1: the new interlock WELDS ONTO AN S2 VALVE (mt#2466 item 5,
  // matching the SVG board's "closes onto an S2 valve" arc) — the rule
  // becomes a guard on the pipe, entering the valve before DONE.
  {
    id: "learn-to-s1",
    source: "learning-loop",
    sourceHandle: "learn-out",
    target: "s2-valve-done",
    targetHandle: "valve-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--vsm-learn) / 0.75)`, strokeWidth: 1.5 },
    label: "new interlock",
    labelStyle: edgeLabelStyle("var(--vsm-learn)"),
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },

  // Infra Supply → S1 (infra powers the operations line).
  // Enters at the head of the line (TASKS bottom) through the open left
  // region — entering SESSIONS from the left shared the x≈400 approach
  // channel with the seam→S5 "decision ↓" edge and superimposed the two.
  {
    id: "infra-to-s1",
    source: "infra-supply",
    sourceHandle: "infra-out",
    target: "s1-tasks",
    targetHandle: "tasks-power-in",
    type: "smoothstep",
    style: { stroke: `oklch(var(--muted-foreground) / 0.55)`, strokeDasharray: "2 6", strokeWidth: 1.5 },
    label: "powers",
    labelStyle: edgeLabelStyle("var(--muted-foreground)"),
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },
];

// ---------------------------------------------------------------------------
// Plant legend — the reading grammar (mt#2466 item 8), ported from the SVG
// board's legend sidebar. Lives in a react-flow Panel in the bottom-right
// (the board's open corner). Collapsible; collapsed by default (mt#2591 —
// info-on-demand default avoids crowding the S1 pipeline tail when open).
// ---------------------------------------------------------------------------

const LEGEND_ORGANS: Array<{ colorVar: string; label: string }> = [
  { colorVar: ORGAN_ACCENTS.s1, label: "S1 operations" },
  { colorVar: ORGAN_ACCENTS.s2, label: "S2 valves (interlocks)" },
  { colorVar: ORGAN_ACCENTS.s3, label: "S3 management + 3★" },
  { colorVar: ORGAN_ACCENTS.s4, label: "S4 future" },
  { colorVar: ORGAN_ACCENTS.s5, label: "S5 identity" },
  { colorVar: ORGAN_ACCENTS.seam, label: "attention seam" },
  { colorVar: ORGAN_ACCENTS.learn, label: "learning loop" },
];

function PlantLegend() {
  // Collapsed by default (mt#2591): the expanded panel's bottom-right footprint
  // crowded the S1 pipeline tail (REVIEW/DONE) and the Learning Loop label at
  // narrower viewports. Collapse-by-default is the info-on-demand default the
  // ISA-101 HMI discipline recommends (mt#2466 canon) and keeps the common view
  // calm; the reading grammar stays one click away via the toggle below.
  const [open, setOpen] = useState(false);

  return (
    <div
      className="rounded-md border border-border bg-card/95 font-mono"
      data-testid="plant-legend"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-2.5 py-1.5 text-[9px] tracking-[0.12em] uppercase text-muted-foreground hover:text-foreground transition-colors w-full"
        aria-expanded={open}
        aria-label={open ? "Collapse legend" : "Expand legend"}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>legend</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 flex flex-col gap-2 max-w-[200px]">
          <div className="flex flex-col gap-1">
            <div className="text-[8px] tracking-[0.1em] uppercase text-muted-foreground/70">
              organs (VSM)
            </div>
            {LEGEND_ORGANS.map((o) => (
              <div key={o.label} className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full flex-none"
                  style={{ background: `oklch(${o.colorVar} / 0.9)` }}
                  aria-hidden="true"
                />
                <span className="text-[9px] text-muted-foreground">{o.label}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="text-[8px] tracking-[0.1em] uppercase text-muted-foreground/70">
              timescales
            </div>
            <div className="text-[9px] text-muted-foreground">
              <span className="font-bold">STABLE</span> — pipes · organs
            </div>
            <div className="text-[9px] text-muted-foreground">
              <span className="font-bold">FLUID</span> — instances as flow/level
            </div>
            <div className="text-[9px] text-muted-foreground">
              <span className="font-bold">BREATH</span> — levels, ~60s poll
            </div>
            <div className="text-[9px] text-muted-foreground">
              <span className="font-bold">SLOW</span> — plant grows valves
            </div>
          </div>
          <div className="text-[8px] text-muted-foreground/70 leading-snug">
            idle-honest: gestures fire only on real system events; breath and a
            pending ask are the only ambient cues. READY is live; — = placeholder.
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main: PlantFlowCanvas (inner — needs ReactFlowProvider)
// ---------------------------------------------------------------------------

function PlantFlowCanvas() {
  const { data: readyCount, isLoading: readyLoading } = useReadyCount();
  const { data: openAskCount, isLoading: openAskLoading, isError: openAskError } =
    useOpenAskCount();
  const {
    data: backlogCounts,
    isLoading: backlogLoading,
    isError: backlogError,
  } = useTaskBacklogCounts();
  const { data: s3Gauges } = useS3Gauges();
  const { data: systemHealth } = useSystemHealth();
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  // -------------------------------------------------------------------------
  // Fast-clock gesture engine (mt#2377 v2.0). Polls system_events; the FIRST
  // poll only baselines (history is not motion); each subsequent poll fires
  // the fixed gesture dictionary for genuinely-new rows. Expired gestures are
  // pruned so the indefinite SMIL dots unmount.
  // -------------------------------------------------------------------------
  const { data: eventRows } = useSystemEvents();
  const engineRef = useRef(createGestureEngineState());
  const [activeGestures, setActiveGestures] = useState<{
    edgeDots: Record<string, { until: number; colorVar: string }>;
    edgeFlashes: Record<string, { until: number }>;
    nodePulses: Record<string, { until: number; colorVar: string }>;
  }>({ edgeDots: {}, edgeFlashes: {}, nodePulses: {} });

  useEffect(() => {
    if (!eventRows) return;
    const fresh = takeNewEvents(engineRef.current, eventRows);
    if (fresh.length === 0) return;
    const until = Date.now() + GESTURE_MS;
    setActiveGestures((prev) => {
      const next = {
        edgeDots: { ...prev.edgeDots },
        edgeFlashes: { ...prev.edgeFlashes },
        nodePulses: { ...prev.nodePulses },
      };
      for (const ev of fresh) {
        const g = mapEventToGestures(ev);
        for (const d of g.edgeDots) {
          next.edgeDots[d.edgeId] = { until, colorVar: GESTURE_TONE_VARS[d.tone] };
        }
        for (const f of g.edgeFlashes) {
          next.edgeFlashes[f.edgeId] = { until };
        }
        for (const p of g.nodePulses) {
          next.nodePulses[p.nodeId] = { until, colorVar: GESTURE_TONE_VARS[p.tone] };
        }
      }
      return next;
    });
    const timer = setTimeout(() => {
      const now = Date.now();
      setActiveGestures((prev) => ({
        edgeDots: Object.fromEntries(Object.entries(prev.edgeDots).filter(([, v]) => v.until > now)),
        edgeFlashes: Object.fromEntries(
          Object.entries(prev.edgeFlashes).filter(([, v]) => v.until > now)
        ),
        nodePulses: Object.fromEntries(
          Object.entries(prev.nodePulses).filter(([, v]) => v.until > now)
        ),
      }));
    }, GESTURE_MS + 200);
    return () => clearTimeout(timer);
  }, [eventRows]);

  // Build the initial node layout with placeholder ready data.
  // Live readyCount is propagated into the READY node via `updatedNodes` below,
  // so the layout is only built once (stable memo) without layout-resetting side effects.
  const initialNodes = buildInitialNodes(undefined, false);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(INITIAL_EDGES);

  // Re-run fitView once node dimensions are MEASURED. The `fitView` prop fires
  // before custom HTML node heights are known (bounds = bare positions), which
  // over-zooms and clips the bottom row (mt#2422 R1 defect). This effect refits
  // against real bounds so the whole plant is always inside the viewport.
  //
  // mt#2590: also re-fit whenever the live instrument queries settle. Real
  // data (e.g. "asks open: 517" vs the placeholder "asks open: —", or
  // 3-digit backlog counts vs "—") can be substantially WIDER than the
  // placeholder content nodesInitialized measured at mount — without this,
  // the one-shot fitView leaves later-widened nodes (S3, Infra Supply, the
  // right end of the S1 spine) pushed outside the viewport once real data
  // arrives a beat after first paint.
  useEffect(() => {
    if (nodesInitialized) {
      void fitView({ padding: 0.1, maxZoom: 1.0 });
    }
  }, [
    nodesInitialized,
    fitView,
    readyCount,
    openAskCount,
    backlogCounts,
    s3Gauges,
    systemHealth,
  ]);

  // Propagate live instrument data into each node without resetting layout
  // (mirrors the pre-existing s1-ready readyCount propagation, mt#2590).
  const updatedNodes = useMemo(() => {
    return nodes.map((node) => {
      let out = node;
      if (node.id === "s1-ready") {
        out = {
          ...out,
          data: { ...out.data, readyCount, readyLoading },
        };
      }
      if (node.id === "s5-identity") {
        out = { ...out, data: { ...out.data, openAskCount } };
      }
      if (node.id === "attention-seam") {
        out = {
          ...out,
          data: { ...out.data, openAskCount, openAskLoading, openAskError },
        };
      }
      if (node.id === "s4-future") {
        out = {
          ...out,
          data: {
            ...out.data,
            todoCount: backlogCounts?.todo,
            planningCount: backlogCounts?.planning,
            backlogLoading,
            backlogError,
            deployStatus: systemHealth?.deployStatus ?? null,
          },
        };
      }
      if (node.id === "s3-management") {
        out = {
          ...out,
          data: {
            ...out.data,
            mcpDisconnectCount: s3Gauges?.mcpDisconnects.eligibleCount24h,
            mcpDisconnectThreshold: s3Gauges?.mcpDisconnects.threshold,
            dispatchCount: s3Gauges?.subagentDispatches.partialUncommittedCount,
            dispatchThreshold: s3Gauges?.subagentDispatches.threshold,
          },
        };
      }
      if (node.id === "infra-supply") {
        out = {
          ...out,
          data: {
            ...out.data,
            mcpServerHealth: systemHealth?.infra.mcpServer,
            postgresHealth: systemHealth?.infra.postgres,
            credentialsHealth: systemHealth?.infra.credentials,
            embeddingsHealth: systemHealth?.infra.embeddings,
            reviewerBotHealth: systemHealth?.infra.reviewerBot,
          },
        };
      }
      const pulse = activeGestures.nodePulses[node.id];
      if (pulse && pulse.until > Date.now()) {
        out = {
          ...out,
          className: [out.className, "vsm-gesture-pulse"].filter(Boolean).join(" "),
          style: {
            ...out.style,
            "--gesture-color": pulse.colorVar,
          } as React.CSSProperties,
        };
      }
      return out;
    });
  }, [
    nodes,
    readyCount,
    readyLoading,
    openAskCount,
    openAskLoading,
    openAskError,
    backlogCounts,
    backlogLoading,
    backlogError,
    s3Gauges,
    systemHealth,
    activeGestures,
  ]);

  // Apply edge gestures: traveling-dot data on the spine's gesture edges,
  // flash class on governance edges.
  const renderedEdges = useMemo(() => {
    return edges.map((edge) => {
      let out = edge;
      if (edge.type === "gesture") {
        const dot = activeGestures.edgeDots[edge.id];
        out = {
          ...out,
          data: { ...out.data, gestureUntil: dot?.until, gestureColorVar: dot?.colorVar },
        };
      }
      const flash = activeGestures.edgeFlashes[edge.id];
      if (flash && flash.until > Date.now()) {
        out = { ...out, className: [out.className, "edge-gesture"].filter(Boolean).join(" ") };
      }
      return out;
    });
  }, [edges, activeGestures]);

  const onNodesChangeCallback = useCallback(onNodesChange, [onNodesChange]);
  const onEdgesChangeCallback = useCallback(onEdgesChange, [onEdgesChange]);

  return (
    <ReactFlow
      nodes={updatedNodes}
      edges={renderedEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChangeCallback}
      onEdgesChange={onEdgesChangeCallback}
      fitView
      fitViewOptions={{ padding: 0.1, maxZoom: 1.0 }}
      minZoom={0.25}
      maxZoom={2}
      defaultEdgeOptions={{
        // Visible teal default for any edge without an explicit style
        style: {
          stroke: `oklch(var(--vsm-s1) / 0.60)`,
          strokeWidth: 1.5,
        },
        labelBgStyle: EDGE_LABEL_BG_STYLE,
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
        labelShowBg: true,
      }}
      proOptions={{ hideAttribution: true }}
      style={{ background: "oklch(var(--background) / 1)" }}
      aria-label="Minsky plant flow diagram — VSM organs as connected nodes"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={24}
        size={1}
        color="oklch(var(--border) / 0.5)"
      />
      <Panel position="bottom-right">
        <PlantLegend />
      </Panel>
    </ReactFlow>
  );
}

// ---------------------------------------------------------------------------
// Main: PlantFlowPage
// ---------------------------------------------------------------------------

/** Header banner text + color per real aggregated health state (mt#2590). */
function headerStatusPresentation(health: "nominal" | "degraded" | "unknown" | undefined): {
  label: string;
  className: string;
} {
  switch (health) {
    case "nominal":
      return { label: "● system nominal", className: "text-liveness-healthy" };
    case "degraded":
      return { label: "● system degraded", className: "text-warn-amber" };
    default:
      // Fetch not yet resolved, or every constituent source failed — the
      // honest-fallback rule requires a neutral/unknown state here, never a
      // green claim the data doesn't support.
      return { label: "● status unknown", className: "text-muted-foreground" };
  }
}

export function PlantFlowPage() {
  const { data: systemHealth } = useSystemHealth();
  const headerStatus = headerStatusPresentation(systemHealth?.header);

  return (
    <div
      // The cockpit shell (Layout.tsx) renders a sticky h-14 AppHeader above
      // <main>, and its min-h-screen root means h-full would collapse here
      // (react-flow h:0 gotcha). h-[calc(100vh-3.5rem)] sizes the page to
      // exactly the visible area below the shell header.
      className="flex flex-col h-[calc(100vh-3.5rem)] bg-background text-foreground overflow-hidden"
      data-testid="plant-flow-page"
    >
      {/* Header */}
      <header className="flex items-baseline gap-4 px-[18px] py-[10px] border-b border-border flex-none">
        <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">
          MINSKY · PLANT
        </h1>
        <span className="text-[11px] font-mono text-muted-foreground">
          v2 · node-link canvas · READY tank live · event-driven motion · idle-honest
        </span>
        <span className="ml-auto flex items-center gap-3 text-[11px] font-mono">
          <span className={headerStatus.className} data-testid="header-status">
            {headerStatus.label}
          </span>
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