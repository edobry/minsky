import type React from "react";
import { type Node, type NodeProps, Position } from "@xyflow/react";
import { gaugeFraction, GAUGE_SETPOINT_FRACTION } from "../../hooks/useS3Gauges";
import { MiniGaugeArc } from "./Instruments";
import { type OrganNodeData, ORGAN_ACCENTS, OrganNodeShell } from "./OrganNodeShell";

/**
 * S5/S4/S3 policy-tier organ node components for PlantFlowPage's canvas
 * (mt#2598 split — extracted verbatim from PlantFlowPage.tsx's "S5 Identity
 * node", "S4 Future node", and "S3 Management node" sections).
 */

// ---------------------------------------------------------------------------
// S5 Identity node — policy canopy at the top
// ---------------------------------------------------------------------------

interface S5IdentityNodeData extends OrganNodeData {
  openAskCount?: number | null;
}

export function S5IdentityNode(props: NodeProps<Node<S5IdentityNodeData>>) {
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

export function S4FutureNode(props: NodeProps<Node<S4FutureNodeData>>) {
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

export function S3ManagementNode(props: NodeProps<Node<S3ManagementNodeData>>) {
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
