import { type Node, type NodeProps, Handle, Position } from "@xyflow/react";
import { useNavigate } from "react-router-dom";
import { type ServiceHealth } from "../../hooks/useSystemHealth";
import { type OrganNodeData, ORGAN_ACCENTS, OrganNodeShell } from "./OrganNodeShell";

/**
 * The attention seam, learning loop, infra supply, and S2 interlock valve
 * organ node components for PlantFlowPage's canvas (mt#2598 split —
 * extracted verbatim from PlantFlowPage.tsx's "Attention / Ask seam node",
 * "Learning loop node", "Infra Supply node", and "S2 interlock valve node"
 * sections). These are the organs that couple the S1 process spine to the
 * operator, the learning loop, and the plant's supply chain, rather than
 * being part of the S1/S3/S4/S5 policy/process tiers themselves.
 */

// ---------------------------------------------------------------------------
// Attention / Ask seam node
// ---------------------------------------------------------------------------

interface AttentionSeamNodeData extends OrganNodeData {
  openAskCount?: number | null;
  openAskLoading?: boolean;
  openAskError?: boolean;
}

export function AttentionSeamNode(props: NodeProps<Node<AttentionSeamNodeData>>) {
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

interface LearningLoopNodeData extends OrganNodeData {
  /** Derived interlock count (mt#2602) — null while the slow-clock sweep is still pending. */
  interlockCount?: number | null;
}

export function LearningLoopNode(props: NodeProps<Node<LearningLoopNodeData>>) {
  const accentVar = ORGAN_ACCENTS.learn;
  const navigate = useNavigate();
  const { interlockCount } = props.data as LearningLoopNodeData;
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
          <span style={{ color: `oklch(${accentVar} / 0.7)` }}>
            ⟂ interlock{typeof interlockCount === "number" ? ` (${interlockCount})` : ""}
          </span>
        </div>
        {/*
         * Interlock-history drill-down entry point (mt#2602 acceptance test 2/3).
         * Route renamed from /plant/weld-history (mt#2626, guard vocabulary
         * alignment); the `weld-history-link` test id is kept stable.
         *
         * Points at `/interceptors` since mt#4229 absorbed the drill-down there.
         * The LABEL stays "interlock history": `src/cockpit/CLAUDE.md` fixes
         * "interlock" as the domain noun for UI copy, and the plant board is UI
         * copy — only the destination moved. Navigating straight to the target
         * rather than through the redirect keeps the board off a hop that exists
         * for bookmarks.
         */}
        <button
          type="button"
          onClick={() => navigate("/interceptors")}
          className="self-start text-[8px] font-mono text-muted-foreground hover:text-foreground transition-colors underline decoration-dotted"
          data-testid="weld-history-link"
          aria-label="View interlock history — provenance timeline"
        >
          interlock history →
        </button>
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

export function InfraSupplyNode(props: NodeProps<Node<InfraSupplyNodeData>>) {
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
  /**
   * Derived total interlock count (mt#2602). Only rendered on the
   * `interlockTarget` valve (DONE) — the plant has 4 fixed positional valves
   * regardless of the real hook count (which may be ~30+); the derived
   * inventory surfaces here as a count badge rather than one valve per hook,
   * with the full inventory available in the interlock-history drill-down.
   */
  interlockCount?: number | null;
  [key: string]: unknown;
}

export function S2ValveNode(props: NodeProps<Node<S2ValveNodeData>>) {
  const { valveKey, interlockTarget, interlockCount } = props.data as S2ValveNodeData;
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
      {interlockTarget && typeof interlockCount === "number" && (
        <span
          className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap text-[7px] font-mono text-muted-foreground"
          data-testid="s2-valve-interlock-count"
          title={`${interlockCount} derived interlocks (guard hooks)`}
        >
          {interlockCount} interlocks
        </span>
      )}
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
