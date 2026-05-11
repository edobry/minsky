/**
 * Workstreams widget frontend (mt#1452)
 *
 * Collapsible card view of active workstreams: one card per parent task that
 * has at least one non-terminal child. Each card shows:
 *  - Parent task ID + title in the header
 *  - Active / done / blocked child counts as a pill
 *  - Expand/collapse chevron (default: all open when ≤5 workstreams, collapsed otherwise)
 *  - Child rows with status badges when expanded
 *
 * Status color palette duplicated from TaskGraph.tsx — centralization is a
 * separate refactor concern per mt#1146 review feedback.
 */
import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "../components/Card";

// ---------------------------------------------------------------------------
// Types — inline mirror of the server WorkstreamCard / WorkstreamsPayload shapes.
// Frontend must stay self-contained (no server imports).
// Keep in sync with src/cockpit/widgets/workstreams.ts.
// ---------------------------------------------------------------------------

type TaskStatus =
  | "TODO"
  | "READY"
  | "IN-PROGRESS"
  | "IN-REVIEW"
  | "DONE"
  | "BLOCKED"
  | "CLOSED"
  | "PLANNING";

interface WorkstreamChild {
  id: string;
  title: string;
  status: TaskStatus;
}

interface WorkstreamCard {
  parentId: string;
  parentTitle: string;
  parentStatus: TaskStatus;
  children: WorkstreamChild[];
  activeChildCount: number;
  doneChildCount: number;
  blockedChildCount: number;
}

interface WorkstreamsPayload {
  workstreams: WorkstreamCard[];
}

type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

interface Props {
  data: WidgetData;
}

// ---------------------------------------------------------------------------
// Status badge helpers
// Duplicated from TaskGraph.tsx — palette mirrors "tech-tree" style from
// deps-rendering-graphviz.ts. Centralization is a separate refactor concern.
// ---------------------------------------------------------------------------

interface StatusStyle {
  background: string;
  border: string;
  color: string;
}

function statusStyle(status: TaskStatus): StatusStyle {
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

function StatusBadge({ status }: { status: TaskStatus }) {
  const s = statusStyle(status);
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
      style={{ background: s.background, color: s.color, border: `1px solid ${s.border}` }}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Chevron icon component
// ---------------------------------------------------------------------------

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Workstream card component
// ---------------------------------------------------------------------------

interface WorkstreamCardProps {
  card: WorkstreamCard;
  defaultOpen: boolean;
}

function WorkstreamCardItem({ card, defaultOpen }: WorkstreamCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Card className="mb-3 last:mb-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm">
              <span className="font-mono text-xs text-muted-foreground mr-1">{card.parentId}</span>
              <span className="font-medium">{card.parentTitle}</span>
            </CardTitle>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Counts pill */}
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {card.activeChildCount} active
              {card.doneChildCount > 0 && ` · ${card.doneChildCount} done`}
              {card.blockedChildCount > 0 && ` · ${card.blockedChildCount} blocked`}
            </span>
            {/* Expand/collapse button */}
            <button
              onClick={() => setIsOpen((prev) => !prev)}
              className="text-muted-foreground hover:text-foreground p-0.5 rounded"
              aria-label={isOpen ? "Collapse workstream" : "Expand workstream"}
            >
              <Chevron open={isOpen} />
            </button>
          </div>
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="pt-0">
          <div className="space-y-1">
            {card.children.map((child) => (
              <div key={child.id} className="flex items-center gap-2 py-1">
                <StatusBadge status={child.status} />
                <span className="text-xs font-mono text-muted-foreground flex-shrink-0">
                  {child.id}
                </span>
                <span className="text-sm truncate">{child.title}</span>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main widget component
// ---------------------------------------------------------------------------

export function Workstreams({ data }: Props) {
  if (data.state === "degraded") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Workstreams</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground">
          <p>{data.reason}</p>
        </CardContent>
      </Card>
    );
  }

  const payload = data.payload as WorkstreamsPayload;
  const workstreams = payload.workstreams ?? [];

  // Default expand/collapse: all open when ≤5 workstreams, all collapsed if >5
  const defaultOpen = workstreams.length <= 5;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Workstreams
          {workstreams.length > 0 && (
            <span className="text-sm font-normal text-muted-foreground ml-2">
              ({workstreams.length} active)
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {workstreams.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active workstreams</p>
        ) : (
          <div>
            {workstreams.map((card) => (
              <WorkstreamCardItem key={card.parentId} card={card} defaultOpen={defaultOpen} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
