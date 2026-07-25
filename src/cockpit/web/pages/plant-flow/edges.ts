import { type Edge } from "@xyflow/react";
import type React from "react";

/**
 * Edge label styling + the plant topology's initial edges (mt#2598 split —
 * extracted verbatim from PlantFlowPage.tsx's "Edge label style helpers" and
 * "Initial edges" sections).
 *
 * No edge is permanently animated (honest-motion law): fast-clock motion is
 * event-driven via the gesture engine (../../lib/plant-gestures.ts), which
 * PlantFlowPage.tsx's canvas component sets transient gesture data / classes
 * for when real system_events rows land.
 */

// ---------------------------------------------------------------------------
// Edge label style helpers — dark-theme-native, no white chip
// ---------------------------------------------------------------------------

/** Base label style for edge text — uses card background, no white chip */
export const EDGE_LABEL_BG_STYLE = {
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
// Initial edges — the plant topology (pipes + seam + recirc + weld)
// ---------------------------------------------------------------------------

export const INITIAL_EDGES: Edge[] = [
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
    style: {
      stroke: `oklch(var(--muted-foreground) / 0.55)`,
      strokeDasharray: "2 6",
      strokeWidth: 1.5,
    },
    label: "powers",
    labelStyle: edgeLabelStyle("var(--muted-foreground)"),
    labelBgStyle: EDGE_LABEL_BG_STYLE,
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 3,
    labelShowBg: true,
  },
];
