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
 *   - Node-type components, instrument/gauge primitives, layout/positioning
 *     constants, and flow-graph (edge) derivation live in ./plant-flow/
 *     (mt#2598 split — this file kept only the canvas orchestration
 *     component, which owns hook state/effects that don't factor cleanly
 *     into standalone modules without behavior risk).
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  ReactFlow,
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
import { useSystemEvents, useReplayEvents, type SystemEventRow } from "../hooks/useSystemEvents";
import { useOpenAskCount } from "../hooks/useOpenAskCount";
import { useTaskBacklogCounts } from "../hooks/useTaskBacklogCounts";
import { useS3Gauges } from "../hooks/useS3Gauges";
import { useSystemHealth } from "../hooks/useSystemHealth";
import { useSlowTopology } from "../hooks/useSlowTopology";
import { ScrubberBar } from "../components/ScrubberBar";
import {
  GESTURE_MS,
  GESTURE_TONE_VARS,
  createGestureEngineState,
  mapEventToGestures,
  takeNewEvents,
} from "../lib/plant-gestures";
import {
  buildReplaySchedule,
  dueSteps,
  isReplayComplete,
  DEFAULT_REPLAY_SPEED,
  type PlantMode,
  type ReplaySpeed,
  type ReplayStep,
  type ReplayWindow,
} from "../lib/plant-replay";
import { buildInitialNodes } from "./plant-flow/layout";
import { INITIAL_EDGES, EDGE_LABEL_BG_STYLE } from "./plant-flow/edges";
import { nodeTypes, edgeTypes } from "./plant-flow/nodeTypes";
import { PlantLegend } from "./plant-flow/PlantLegend";

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
  const { data: slowTopology } = useSlowTopology();
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  // -------------------------------------------------------------------------
  // Fast-clock gesture engine (mt#2377 v2.0, replay added mt#2600). Live mode
  // polls system_events; the FIRST poll only baselines (history is not
  // motion); each subsequent poll fires the fixed gesture dictionary for
  // genuinely-new rows. Replay mode feeds a fetched historical window through
  // the SAME dictionary, paced by lib/plant-replay.ts's pure schedule — both
  // paths converge on the one `fireGestures` callback below so there is no
  // replay-only vocabulary (honest-motion law).
  // -------------------------------------------------------------------------
  const [mode, setMode] = useState<PlantMode>("live");
  const { data: eventRows, refetch: refetchLiveEvents } = useSystemEvents(undefined, mode === "live");
  const engineRef = useRef(createGestureEngineState());
  const [activeGestures, setActiveGestures] = useState<{
    edgeDots: Record<string, { until: number; colorVar: string }>;
    edgeFlashes: Record<string, { until: number }>;
    nodePulses: Record<string, { until: number; colorVar: string }>;
  }>({ edgeDots: {}, edgeFlashes: {}, nodePulses: {} });

  // Outstanding gesture-expiry timers, tracked so they can be cancelled on
  // unmount (fireGestures is called imperatively from both the live-poll
  // effect and the replay ticker, so no single useEffect owns its cleanup).
  const gestureExpiryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = gestureExpiryTimersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const fireGestures = useCallback((events: SystemEventRow[]) => {
    if (events.length === 0) return;
    const until = Date.now() + GESTURE_MS;
    setActiveGestures((prev) => {
      const next = {
        edgeDots: { ...prev.edgeDots },
        edgeFlashes: { ...prev.edgeFlashes },
        nodePulses: { ...prev.nodePulses },
      };
      for (const ev of events) {
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
      gestureExpiryTimersRef.current.delete(timer);
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
    gestureExpiryTimersRef.current.add(timer);
  }, []);

  useEffect(() => {
    if (mode !== "live" || !eventRows) return;
    const fresh = takeNewEvents(engineRef.current, eventRows);
    fireGestures(fresh);
  }, [mode, eventRows, fireGestures]);

  // -------------------------------------------------------------------------
  // Replay (mt#2600): a fixed historical window, ordered + paced by the pure
  // lib/plant-replay.ts engine and stepped by a plain interval here.
  // -------------------------------------------------------------------------
  const [replayWindow, setReplayWindow] = useState<ReplayWindow | null>(null);
  const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>(DEFAULT_REPLAY_SPEED);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySchedule, setReplaySchedule] = useState<ReplayStep[]>([]);
  const [replayPlayheadIso, setReplayPlayheadIso] = useState<string | null>(null);
  const replayEngineRef = useRef({ elapsedMs: 0, firedCount: 0, tickAnchor: null as number | null });

  const { data: replayEventRows } = useReplayEvents(mode === "replay" ? replayWindow : null);

  // A fresh window (or a speed change) rebuilds the schedule and resets
  // playback progress. Speed changes mid-playback restart the window at the
  // new speed rather than drift-correcting an in-flight schedule — an
  // acceptable v1 simplification for a still/paused-by-default replay start.
  useEffect(() => {
    if (mode !== "replay" || !replayEventRows) return;
    setReplaySchedule(buildReplaySchedule(replayEventRows, replaySpeed));
    replayEngineRef.current = { elapsedMs: 0, firedCount: 0, tickAnchor: null };
    setReplayPlayheadIso(null);
  }, [mode, replayEventRows, replaySpeed]);

  useEffect(() => {
    if (mode !== "replay" || !replayPlaying || replaySchedule.length === 0) return;
    const engine = replayEngineRef.current;
    engine.tickAnchor = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const delta = now - (engine.tickAnchor ?? now);
      engine.tickAnchor = now;
      engine.elapsedMs += delta;
      const { due, firedCount } = dueSteps(replaySchedule, engine.elapsedMs, engine.firedCount);
      engine.firedCount = firedCount;
      if (due.length > 0) {
        fireGestures(due.map((s) => s.event));
        setReplayPlayheadIso(due[due.length - 1]?.event.createdAt ?? null);
      }
      if (isReplayComplete(replaySchedule, firedCount)) {
        setReplayPlaying(false);
      }
    }, 100);
    return () => clearInterval(id);
  }, [mode, replayPlaying, replaySchedule, fireGestures]);

  const handleEnterReplay = useCallback((window: ReplayWindow) => {
    setMode("replay");
    setReplayWindow(window);
    setReplayPlaying(false);
  }, []);

  const handleExitReplay = useCallback(() => {
    setMode("live");
    setReplayPlaying(false);
    setReplayWindow(null);
    setReplaySchedule([]);
    replayEngineRef.current = { elapsedMs: 0, firedCount: 0, tickAnchor: null };
    setReplayPlayheadIso(null);
    // Re-baseline (mt#2600 acceptance test): a fresh engine state means the
    // NEXT live poll's takeNewEvents() call treats every currently-existing
    // row — including ones that happened while the live poller was paused
    // during replay — as baseline, not motion. Clearing activeGestures too
    // so no replay-fired gesture lingers past exit.
    engineRef.current = createGestureEngineState();
    setActiveGestures({ edgeDots: {}, edgeFlashes: {}, nodePulses: {} });
    void refetchLiveEvents();
  }, [refetchLiveEvents]);

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
    slowTopology,
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
      // Derived interlock count (mt#2602): propagated into both the
      // learning-loop node's inline readout and the DONE valve's count badge.
      if (node.id === "learning-loop" || node.id === "s2-valve-done") {
        out = {
          ...out,
          data: {
            ...out.data,
            interlockCount: slowTopology?.status === "ready" ? slowTopology.interlockCount : null,
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
    slowTopology,
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

  // Honest-motion law extension (mt#2600): replay must never be mistakable
  // for live — an inset border frame on the whole canvas is the "impossible
  // to miss" signal, on top of the top-center banner + timestamp readout.
  return (
    <div
      className="w-full h-full"
      data-testid="replay-frame"
      style={
        mode === "replay"
          ? { boxShadow: "inset 0 0 0 3px oklch(var(--warn-amber) / 0.85)" }
          : undefined
      }
    >
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
        {mode === "replay" && (
          <Panel position="top-center">
            <div
              className="rounded-md px-3 py-1 font-mono text-[10px] font-bold tracking-[0.12em] uppercase"
              style={{
                color: "oklch(var(--warn-amber) / 1)",
                background: "oklch(var(--card) / 0.95)",
                border: "1px solid oklch(var(--warn-amber) / 0.6)",
              }}
              data-testid="replay-banner"
            >
              ● REPLAY — {replayPlayheadIso ?? replayWindow?.since ?? "…"}
            </div>
          </Panel>
        )}
        <Panel position="bottom-center">
          <ScrubberBar
            mode={mode}
            playing={replayPlaying}
            speed={replaySpeed}
            playheadIso={replayPlayheadIso}
            onEnterReplay={handleEnterReplay}
            onExitReplay={handleExitReplay}
            onPlayPause={() => setReplayPlaying((p) => !p)}
            onSpeedChange={setReplaySpeed}
          />
        </Panel>
        <Panel position="bottom-right">
          <PlantLegend />
        </Panel>
      </ReactFlow>
    </div>
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
