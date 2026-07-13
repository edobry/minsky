/**
 * Attention widget frontend (mt#1147, digest-ified mt#2368)
 *
 * Overview-grid DIGEST of pending operator-routed Asks. This widget is the
 * homepage "you have N pending" surface, NOT a management surface:
 *
 *   - It shows a compact, priority-sorted list of the active-window cohort —
 *     one line per ask (priority badge, kind, title, deadline, age).
 *   - It does NOT render the per-ask humility checklist, options, drivers,
 *     context refs, or response/defer/escalate buttons inline. Those belong
 *     to the dedicated management surface (`/asks`, AsksPage), which provides
 *     list -> detail -> respond/defer/escalate.
 *   - The whole digest, and each row, links through to `/asks`.
 *   - Empty state ("no pending asks") is desirable, not an error.
 *
 * This split mirrors the sibling status widgets (BasicHealth, CredentialsSummary):
 * the home grid shows a roll-up; full detail lives on a page route. See the
 * cockpit IA convention in src/cockpit/CLAUDE.md ("status indicators ... -> card;
 * interactive tools with list+detail ... -> dedicated page route").
 *
 * Transport: TanStack Query polling at 10s.
 * Data source: GET /api/widget/attention/data
 *
 * Types mirror src/cockpit/widgets/attention.ts (no server imports on frontend).
 */
import { Link } from "react-router-dom";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

// ---------------------------------------------------------------------------
// Types — inline mirrors of server AttentionPayload / AttentionAsk.
// Keep in sync with src/cockpit/widgets/attention.ts.
// ---------------------------------------------------------------------------

type AskKind =
  | "capability.escalate"
  | "information.retrieve"
  | "authorization.approve"
  | "direction.decide"
  | "coordination.notify"
  | "quality.review"
  | "stuck.unblock";

type AskState =
  | "detected"
  | "classified"
  | "routed"
  | "suspended"
  | "responded"
  | "closed"
  | "cancelled"
  | "expired";

interface AskOption {
  label: string;
  value: unknown;
  description?: string;
}

interface ContextRef {
  kind: string;
  ref: string;
  description?: string;
}

interface AttentionAsk {
  id: string;
  kind: AskKind;
  state: AskState;
  title: string;
  question: string;
  requestor: string;
  routingTarget?: string;
  parentTaskId?: string;
  parentSessionId?: string;
  options?: AskOption[];
  contextRefs?: ContextRef[];
  deadline?: string;
  createdAt: string;
  suspendedAt?: string;
  windowKey?: string;
  windowMissedCount: number;
  serviceStrategy?: "asap" | "scheduled" | "deadline-bound";
  metadata: Record<string, unknown>;
}

interface ActiveWindowInfo {
  windowKey: string;
  openedAt?: string;
  expectedCloseAt?: string;
}

interface AttentionPayload {
  activeWindow: ActiveWindowInfo | null;
  cohort: AttentionAsk[];
  totalPending: number;
}

/** Max rows to show in the digest before collapsing the remainder into an overflow link. */
const DIGEST_LIMIT = 5;

// ---------------------------------------------------------------------------
// Payload guard
// ---------------------------------------------------------------------------

function isAttentionPayload(payload: unknown): payload is AttentionPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { cohort?: unknown }).cohort) &&
    typeof (payload as { totalPending?: unknown }).totalPending === "number"
  );
}

// ---------------------------------------------------------------------------
// Relative time helper — no external dep
// ---------------------------------------------------------------------------

function formatRelative(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return "unknown";

  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/** Time remaining until deadline — returns null if no deadline or past. */
function formatDeadlineRemaining(isoDeadline: string | undefined): string | null {
  if (!isoDeadline) return null;
  const deadline = new Date(isoDeadline).getTime();
  const now = Date.now();
  const diffMs = deadline - now;
  if (diffMs <= 0) return "overdue";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m left`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h left`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d left`;
}

// ---------------------------------------------------------------------------
// Kind color helpers — semantic tokens preferred; raw hex only where the
// semantic palette lacks a suitable token (status-specific colors pending
// palette extension per cockpit-design skill).
// ---------------------------------------------------------------------------

interface KindStyle {
  /** Tailwind classes for the kind badge */
  badge: string;
  /** Short human-readable label */
  label: string;
  /** Priority band label */
  priority: string;
}

function kindStyle(kind: AskKind): KindStyle {
  switch (kind) {
    case "stuck.unblock":
      return {
        badge: "bg-destructive text-destructive-foreground",
        label: "stuck.unblock",
        priority: "P1",
      };
    case "authorization.approve":
      return {
        badge: "bg-destructive/60 text-foreground",
        label: "authorization.approve",
        priority: "P2",
      };
    case "direction.decide":
      return {
        badge: "bg-accent text-accent-foreground",
        label: "direction.decide",
        priority: "P3",
      };
    case "quality.review":
      return {
        badge: "bg-secondary text-secondary-foreground",
        label: "quality.review",
        priority: "P4",
      };
    case "coordination.notify":
      return {
        badge: "bg-muted text-muted-foreground",
        label: "coordination.notify",
        priority: "P5",
      };
    case "capability.escalate":
      return {
        badge: "bg-muted text-muted-foreground",
        label: "capability.escalate",
        priority: "P6",
      };
    case "information.retrieve":
      return {
        badge: "bg-muted text-muted-foreground",
        label: "information.retrieve",
        priority: "P7",
      };
  }
}

// ---------------------------------------------------------------------------
// Digest row — one compact line per ask, links through to /asks.
// No inline expansion, no response affordances (those live on AsksPage).
// ---------------------------------------------------------------------------

function DigestRow({ ask }: { ask: AttentionAsk }) {
  const ks = kindStyle(ask.kind);
  const deadlineStr = formatDeadlineRemaining(ask.deadline);
  const ageStr = formatRelative(ask.createdAt);
  const isOverdue = deadlineStr === "overdue";

  return (
    <Link
      to="/asks"
      className="flex items-center gap-2 rounded border border-border bg-card/50 px-2.5 py-1.5 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
    >
      {/* Priority badge */}
      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${ks.badge}`}>
        {ks.priority}
      </span>

      {/* Title + kind */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground truncate">{ask.title}</p>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-muted-foreground truncate min-w-0">{ask.kind}</span>
          {ask.parentTaskId && (
            <span
              className="text-xs font-mono text-muted-foreground truncate max-w-[10rem]"
              title={ask.parentTaskId}
            >
              {ask.parentTaskId}
            </span>
          )}
        </div>
      </div>

      {/* Deadline badge */}
      {deadlineStr && (
        <span
          className={`text-xs flex-shrink-0 tabular-nums ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}
        >
          {deadlineStr}
        </span>
      )}

      {/* Age */}
      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">{ageStr}</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Chrome-agnostic body — no Card/CardHeader/CardTitle in any branch
// ---------------------------------------------------------------------------

interface AttentionBodyProps {
  query: UseQueryResult<WidgetData, Error>;
}

function AttentionBody({ query }: AttentionBodyProps) {
  // Error state
  if (query.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        Failed to load attention data: {query.error.message}
      </p>
    );
  }

  // Loading state
  if (query.isLoading || !query.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  const data = query.data;

  // Degraded state (server-reported)
  if (data.state === "degraded") {
    return <p className="text-muted-foreground text-sm">{data.reason}</p>;
  }

  // Payload shape guard
  if (!isAttentionPayload(data.payload)) {
    return <p className="text-muted-foreground text-sm">Unexpected payload shape</p>;
  }

  const { activeWindow, cohort, totalPending } = data.payload;
  const visible = cohort.slice(0, DIGEST_LIMIT);
  const overflow = cohort.length - visible.length;

  return (
    <>
      {/* Pending count + active window — inlined below the shell title */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          {totalPending > 0 && (
            <Link
              to="/asks"
              className="text-sm font-normal text-muted-foreground hover:text-foreground transition-colors"
            >
              {totalPending} pending →
            </Link>
          )}
        </div>

        {/* Active window indicator */}
        {activeWindow && (
          <div className="flex-shrink-0 text-right">
            <div className="text-xs font-mono text-foreground font-medium">
              {activeWindow.windowKey}
            </div>
            {activeWindow.expectedCloseAt && (
              <div className="text-xs text-muted-foreground">
                closes {formatDeadlineRemaining(activeWindow.expectedCloseAt) ?? "soon"}
              </div>
            )}
          </div>
        )}
      </div>

      {cohort.length === 0 ? (
        /* Empty state — desirable, not an error.
           The cohort is active-window-scoped; totalPending is global. When the
           active window is clear but other windows still hold asks, reflect that
           instead of asserting "all clear" (which would contradict the header
           count). */
        <div className="py-3 text-center">
          <p className="text-sm font-medium text-foreground">
            {activeWindow ? "No asks in this window" : "No pending asks"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {totalPending > 0 ? (
              <Link to="/asks" className="hover:text-foreground transition-colors">
                {totalPending} pending{activeWindow ? " in other windows" : ""} →
              </Link>
            ) : activeWindow ? (
              `Window "${activeWindow.windowKey}" is open — all clear.`
            ) : (
              "No active window — all clear."
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {visible.map((ask) => (
            <DigestRow key={ask.id} ask={ask} />
          ))}

          {overflow > 0 && (
            <Link
              to="/asks"
              className="block pt-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              + {overflow} more →
            </Link>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main widget component — self-fetching via TanStack Query (mt#2373)
// ---------------------------------------------------------------------------

async function fetchAttention(): Promise<WidgetData> {
  return fetchWidgetData("attention");
}

interface AttentionProps {
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

export function Attention({ variant = "card", title = "Attention" }: AttentionProps) {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["attention"],
    queryFn: fetchAttention,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });

  return (
    <WidgetShell variant={variant} title={title}>
      <AttentionBody query={query} />
    </WidgetShell>
  );
}
