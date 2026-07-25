import { type Node, type NodeProps, Position } from "@xyflow/react";
import { VesselTank } from "./Instruments";
import { type OrganNodeData, ORGAN_ACCENTS, OrganNodeShell } from "./OrganNodeShell";

/**
 * S1 lifecycle-stage organ node components for PlantFlowPage's canvas
 * (mt#2598 split — extracted verbatim from PlantFlowPage.tsx's "S1 lifecycle
 * stage nodes — TASKS, READY, SESSIONS, AGENTS, PR, REVIEW, DONE" section).
 * These are the main process line — each is a separate node connected by
 * edges (see plant-flow/edges.ts).
 */

export interface S1StageNodeData extends OrganNodeData {
  stage: string;
  readyCount?: number;
  readyLoading?: boolean;
}

export function S1TasksNode(_props: NodeProps<Node<S1StageNodeData>>) {
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

export function S1ReadyNode(props: NodeProps<Node<S1StageNodeData>>) {
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

export function S1SessionsNode(_props: NodeProps<Node<S1StageNodeData>>) {
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

export function S1AgentsNode(_props: NodeProps<Node<S1StageNodeData>>) {
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

export function S1PRNode(_props: NodeProps<Node<S1StageNodeData>>) {
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

export function S1ReviewNode(_props: NodeProps<Node<S1StageNodeData>>) {
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

export function S1DoneNode(_props: NodeProps<Node<S1StageNodeData>>) {
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
