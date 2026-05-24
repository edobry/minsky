/**
 * Task Graph widget frontend (mt#1146)
 *
 * React-flow powered interactive DAG of the Minsky task dependency graph.
 * Receives {nodes, edges} payload from the server widget and renders with:
 *  - Status-colored nodes (same palette as the tech-tree style in
 *    deps-rendering-graphviz.ts)
 *  - Pan / zoom via react-flow defaults
 *  - Click-to-select: shows a side panel with task title + status
 *  - Auto-layout via a simple topological-sort / generation-based placement
 *    (no external dagre dep required for v0)
 *  - Zoom/pan preserved across poll refreshes via useEffect sync that only
 *    updates node/edge data, not the ReactFlow viewport
 *
 * Extension points:
 *   TODO(mt#442): When routing overlay ships, highlight "available" nodes
 *     and render the critical-path edge set from `tasks route` output.
 *   TODO(mt#240): When task-type overlay ships, additively color-code by
 *     task classification using a configurable legend.
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import ReactFlow, {
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "reactflow";
import "reactflow/dist/style.css";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";

// ---------------------------------------------------------------------------
// Types — inline mirror of the server GraphNode / GraphEdge shapes.
// Frontend must stay self-contained (no server imports).
// Keep in sync with src/cockpit/widgets/task-graph.ts.
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  label: string;
  status:
    | "TODO"
    | "READY"
    | "IN-PROGRESS"
    | "IN-REVIEW"
    | "DONE"
    | "BLOCKED"
    | "CLOSED"
    | "PLANNING";
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

interface TaskGraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

interface Props {
  data: WidgetData;
  /** Override the canvas container height class. Defaults to `h-[600px]` for
   * card-context usage. Full-page consumers (TasksPage) pass a viewport-relative
   * class like `h-[calc(100vh-14rem)]` so the graph fills the available space. */
  containerClassName?: string;
}

// ---------------------------------------------------------------------------
// Status color palette
// Mirrors the "tech-tree" style from deps-rendering-graphviz.ts
// ---------------------------------------------------------------------------

interface StatusStyle {
  background: string;
  border: string;
  color: string;
}

function statusStyle(status: GraphNode["status"]): StatusStyle {
  switch (status) {
    case "DONE":
      return { background: "#34d399", border: "#059669", color: "#064e3b" };
    case "IN-PROGRESS":
      return { background: "#fbbf24", border: "#d97706", color: "#78350f" };
    case "IN-REVIEW":
      return { background: "#a78bfa", border: "#7c3aed", color: "#2e1065" };
    case "READY":
      return { background: "#60a5fa", border: "#2563eb", color: "#1e3a8a" };
    case "BLOCKED":
      return { background: "#f87171", border: "#dc2626", color: "#7f1d1d" };
    case "PLANNING":
      return { background: "#67e8f9", border: "#0891b2", color: "#164e63" };
    case "CLOSED":
      return { background: "#d1d5db", border: "#6b7280", color: "#374151" };
    case "TODO":
    default:
      return { background: "#e2e8f0", border: "#64748b", color: "#1e293b" };
  }
}

// ---------------------------------------------------------------------------
// Auto-layout: topological generation placement
//
// Assigns each node an (x, y) position based on its topological generation
// (distance from the source nodes). Nodes with no predecessors are in
// generation 0; each successor generation is one step further right.
// Within a generation, nodes are evenly spaced top-to-bottom.
//
// This avoids pulling in dagre as an additional dependency for v0.
// ---------------------------------------------------------------------------

const NODE_WIDTH = 180;
const NODE_HEIGHT = 60;
const H_GAP = 60; // horizontal gap between generations
const V_GAP = 20; // vertical gap between nodes in same generation

function computeLayout(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Map<string, { x: number; y: number }> {
  // Build adjacency: predecessors = dependencies (the nodes a task NEEDS)
  //
  // Edge semantics (from src/domain/tasks/task-graph-service.ts):
  //   edge.source = fromTaskId = dependent (the task that *has* a dependency)
  //   edge.target = toTaskId   = dependency (the task that *is* depended on)
  //
  // For prerequisite-left, dependent-right layout: predecessors of X are X's
  // dependencies, i.e., the edge.target for every edge where X = edge.source.
  // (PR #1031 R1 reviewer finding — original direction was inverted.)
  const predecessors = new Map<string, Set<string>>();
  for (const n of nodes) {
    predecessors.set(n.id, new Set());
  }
  for (const e of edges) {
    const preds = predecessors.get(e.source);
    if (preds) preds.add(e.target);
  }

  // Kahn's BFS-based topological sort to assign generation numbers
  const generation = new Map<string, number>();
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    inDegree.set(n.id, predecessors.get(n.id)?.size ?? 0);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      generation.set(id, 0);
      queue.push(id);
    }
  }

  // Build successor map for BFS (mirror of the predecessors flip above):
  // successors of X = X's dependents = edge.source for every edge where
  // X = edge.target. (PR #1031 R1 reviewer finding.)
  const successors = new Map<string, string[]>();
  for (const n of nodes) {
    successors.set(n.id, []);
  }
  for (const e of edges) {
    successors.get(e.target)?.push(e.source);
  }

  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    const gen = generation.get(curr) ?? 0;
    for (const succ of successors.get(curr) ?? []) {
      const existing = generation.get(succ) ?? -1;
      if (gen + 1 > existing) {
        generation.set(succ, gen + 1);
      }
      const newDeg = (inDegree.get(succ) ?? 1) - 1;
      inDegree.set(succ, newDeg);
      if (newDeg === 0) {
        queue.push(succ);
      }
    }
  }

  // Nodes not reached by BFS (cycles) get generation = max + 1
  const maxGen = Math.max(0, ...generation.values());
  for (const n of nodes) {
    if (!generation.has(n.id)) {
      generation.set(n.id, maxGen + 1);
    }
  }

  // Group nodes by generation
  const byGeneration = new Map<number, string[]>();
  for (const [id, gen] of generation) {
    if (!byGeneration.has(gen)) byGeneration.set(gen, []);
    byGeneration.get(gen)?.push(id);
  }

  // Assign positions: x = generation * (NODE_WIDTH + H_GAP), y centered in group
  const positions = new Map<string, { x: number; y: number }>();
  for (const [gen, ids] of byGeneration) {
    const totalH = ids.length * NODE_HEIGHT + (ids.length - 1) * V_GAP;
    const startY = -totalH / 2;
    ids.forEach((id, idx) => {
      positions.set(id, {
        x: gen * (NODE_WIDTH + H_GAP),
        y: startY + idx * (NODE_HEIGHT + V_GAP),
      });
    });
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Conversion: server shapes → react-flow shapes
// ---------------------------------------------------------------------------

function toFlowNodes(
  graphNodes: GraphNode[],
  positions: Map<string, { x: number; y: number }>
): Node[] {
  return graphNodes.map((n) => {
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    const style = statusStyle(n.status);
    return {
      id: n.id,
      position: pos,
      data: { label: n.label, status: n.status },
      style: {
        background: style.background,
        border: `2px solid ${style.border}`,
        color: style.color,
        borderRadius: "6px",
        padding: "6px 10px",
        fontSize: "11px",
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        boxSizing: "border-box" as const,
        whiteSpace: "pre-wrap" as const,
        wordBreak: "break-word" as const,
      },
    };
  });
}

function toFlowEdges(graphEdges: GraphEdge[]): Edge[] {
  return graphEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    style: { stroke: "#4a5568", strokeWidth: 1.5 },
    animated: false,
  }));
}

// ---------------------------------------------------------------------------
// Selected-node panel
// ---------------------------------------------------------------------------

interface SelectedPanelProps {
  node: { id: string; label: string; status: string } | null;
  onClose: () => void;
}

function SelectedPanel({ node, onClose }: SelectedPanelProps) {
  if (!node) return null;

  return (
    <div
      className="absolute bottom-4 right-4 z-10 bg-card border border-border rounded-lg shadow-lg p-4 min-w-[220px] max-w-[300px]"
      style={{ position: "absolute" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground font-mono mb-1">{node.id}</p>
          <p className="text-sm font-medium leading-snug break-words">{node.label}</p>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg leading-none flex-shrink-0 mt-0.5"
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className="mt-2">
        <span className="text-xs px-2 py-0.5 rounded-full font-medium"
          style={(() => {
            const s = statusStyle(node.status as GraphNode["status"]);
            return { background: s.background, color: s.color, border: `1px solid ${s.border}` };
          })()}
        >
          {node.status}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main widget component
// ---------------------------------------------------------------------------

export function TaskGraph({ data, containerClassName = "h-[600px]" }: Props) {
  // Track whether ReactFlow has performed its initial fit-to-view. After the
  // first onInit, subsequent renders skip fitView so polling refreshes don't
  // snap the user's viewport back to the default.
  const hasFittedRef = useRef(false);
  const navigate = useNavigate();
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);
  const [selected, setSelected] = useState<{
    id: string;
    label: string;
    status: string;
  } | null>(null);

  // Sync incoming data into rf state — update nodes/edges without resetting viewport
  useEffect(() => {
    if (data.state !== "ok") return;
    const payload = data.payload as TaskGraphPayload;
    const gNodes = payload.nodes ?? [];
    const gEdges = payload.edges ?? [];

    const positions = computeLayout(gNodes, gEdges);
    const nextNodes = toFlowNodes(gNodes, positions);
    const nextEdges = toFlowEdges(gEdges);

    // Update node positions and data only — ReactFlow keeps viewport separately
    setRfNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      return nextNodes.map((n) => {
        const existing = prevMap.get(n.id);
        if (existing) {
          // preserve user-dragged position if node already exists
          return { ...n, position: existing.position };
        }
        return n;
      });
    });
    setRfEdges(nextEdges);
  }, [data, setRfNodes, setRfEdges]);

  // Node click: update the side panel AND navigate to the task detail page
  const handleNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => {
      setSelected({
        id: node.id,
        label: (node.data as { label: string }).label,
        status: (node.data as { status: string }).status,
      });
      navigate(`/tasks/${encodeURIComponent(node.id)}`);
    },
    [navigate]
  );

  if (data.state === "degraded") {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Task Graph</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>{data.reason}</p>
        </CardContent>
      </Card>
    );
  }

  const payload = data.payload as TaskGraphPayload;
  const nodeCount = payload.nodes?.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">
          Task Graph
          {nodeCount > 0 && (
            <span className="text-sm font-normal text-muted-foreground ml-2">
              ({nodeCount} tasks)
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {nodeCount === 0 ? (
          <p className="text-sm text-muted-foreground p-4">No tasks yet</p>
        ) : (
          <div className={`relative ${containerClassName}`}>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={handleNodeClick}
              // fitView fires once on first mount only. Subsequent poll
              // refreshes update node/edge data without resetting the
              // viewport, so users can zoom/pan and stay there.
              // (PR #1031 R1 NON-BLOCKING reviewer finding.)
              {...(hasFittedRef.current ? {} : { fitView: true, fitViewOptions: { padding: 0.2 } })}
              minZoom={0.1}
              maxZoom={2}
              attributionPosition="bottom-left"
              onInit={() => {
                hasFittedRef.current = true;
              }}
            >
              <Background />
              <Controls />
            </ReactFlow>
            <SelectedPanel node={selected} onClose={() => setSelected(null)} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
