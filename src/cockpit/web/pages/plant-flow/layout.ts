import { type Node } from "@xyflow/react";
import { ORGAN_ACCENTS } from "./OrganNodeShell";
import { type S1StageNodeData } from "./StageNodes";

/**
 * Initial node positions — fixed layout encoding the VSM topology (mt#2598
 * split — extracted verbatim from PlantFlowPage.tsx's "Initial node
 * positions" section).
 *
 * Layout design (mt#2466 instrument-parity pass, re-tuned for the sidebar
 * shell: canvas ≈ 1200×805 at 1440×900, aspect ~1.49):
 *   Row 0 (y=0):   S5 Identity (top, left-of-center)
 *   Row 1 (y=160): S4 Future (left) | S3 Management (right)
 *   Row 2 (y=400): S1 lifecycle spine + S2 interlock valves ON the pipe
 *   Row 3 (y=550): Attention Seam (center-left) | Learning Loop (center-right)
 *                  — at 550 (not lower) so the learning→valve interlock edge's
 *                  smoothstep midpoint stays ABOVE the bottom-right legend panel
 *   Row 4 (y=770): Infra Supply (bottom left) → bottom ≈ 840
 *
 * Bounding box ≈ 1276 × 840 (aspect ~1.5) — close to the post-sidebar canvas
 * aspect, so fitView fills both axes. S5.x=402 puts the seam→S5 "decision ↓"
 * approach channel (s5-in left handle, approach ≈ x-22 = 380) through the
 * READY/SESSIONS spine gap — the one gap WITHOUT an S2 valve.
 * Robustness: positions are a hint; PlantFlowPage.tsx's nodes-initialized
 * refit effect re-runs fitView with MEASURED node bounds, so nothing clips
 * even if node heights drift from these estimates.
 */

const SPINE_Y = 400;
const SPINE_SPACING = 182;
const SPINE_START_X = 30;
/** Vertical center of the spine pipe — valves sit on it. */
const VALVE_Y = 426;

export function buildInitialNodes(readyCount: number | undefined, readyLoading: boolean): Node[] {
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
      data: {
        organKey: "s1",
        label: "TASKS",
        sublabel: "",
        accentVar: ORGAN_ACCENTS.s1,
        stage: "tasks",
      },
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
      data: {
        organKey: "s1",
        label: "SESSIONS",
        sublabel: "",
        accentVar: ORGAN_ACCENTS.s1,
        stage: "sessions",
      },
      draggable: true,
    },
    {
      id: "s1-agents",
      type: "s1-agents",
      position: { x: SPINE_START_X + SPINE_SPACING * 3, y: SPINE_Y },
      data: {
        organKey: "s1",
        label: "AGENTS",
        sublabel: "",
        accentVar: ORGAN_ACCENTS.s1,
        stage: "agents",
      },
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
      data: {
        organKey: "s1",
        label: "REVIEW",
        sublabel: "",
        accentVar: ORGAN_ACCENTS.s1,
        stage: "review",
      },
      draggable: true,
    },
    {
      id: "s1-done",
      type: "s1-done",
      position: { x: SPINE_START_X + SPINE_SPACING * 6, y: SPINE_Y },
      data: {
        organKey: "s1",
        label: "DONE",
        sublabel: "",
        accentVar: ORGAN_ACCENTS.s1,
        stage: "done",
      },
      draggable: true,
    },

    // Attention / Ask seam — below spine, center-left
    {
      id: "attention-seam",
      type: "attention-seam",
      position: { x: 420, y: 550 },
      data: {
        organKey: "seam",
        label: "Attention · Ask Seam",
        sublabel: "",
        accentVar: ORGAN_ACCENTS.seam,
      },
      draggable: true,
    },

    // Learning loop — below spine, center-right; right edge clears the
    // bottom-right legend panel's viewport column
    {
      id: "learning-loop",
      type: "learning-loop",
      position: { x: 760, y: 550 },
      data: {
        organKey: "learn",
        label: "Learning Loop",
        sublabel: "",
        accentVar: ORGAN_ACCENTS.learn,
      },
      draggable: true,
    },

    // Infra Supply — bottom left, clear of the seam's column so its supply
    // edge rises through the open left region
    {
      id: "infra-supply",
      type: "infra-supply",
      position: { x: 140, y: 770 },
      data: {
        organKey: "infra",
        label: "Infra Supply",
        sublabel: "",
        accentVar: ORGAN_ACCENTS.infra,
      },
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
