/**
 * ActivityPage — full-page route for the system event activity feed (/activity).
 *
 * Read-only chronological log of system events. Defaults to the `actionable`
 * category (asks, auto-filed tasks, reviews, failures); a "Show informational"
 * toggle reveals the wider informational/trajectory stream that is persisted
 * for the Phase 2 noticer but hidden by default. The operator scrolls through
 * to see what happened while they weren't looking.
 *
 * Self-fetching via TanStack Query against GET /api/activity.
 *
 * @see mt#2092 — Event log Phase 1a
 * @see mt#2340 — write/read-scope split (category filter + informational toggle)
 */
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "../components/ui/card";
import { cn } from "../lib/utils";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Types — mirrors of server SystemEvent shape
// ---------------------------------------------------------------------------

type SystemEventType =
  | "ask.created"
  | "task.auto_created"
  | "pr.review_posted"
  | "subagent.failed"
  | "embeddings.provider_degraded"
  | "task.status_changed"
  | "pr.merged"
  | "subagent.completed"
  | "session.started";

interface SystemEvent {
  id: string;
  eventType: SystemEventType;
  payload: Record<string, unknown>;
  actor?: string;
  relatedTaskId?: string;
  relatedSessionId?: string;
  createdAt: string;
}

interface ActivityListResponse {
  events: SystemEvent[];
  total: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function fetchActivity(
  eventType: string,
  showInformational: boolean
): Promise<ActivityListResponse> {
  const params = new URLSearchParams();
  if (eventType !== "all") {
    // Explicit single-type drill-down wins over the category default.
    params.set("eventType", eventType);
  } else if (!showInformational) {
    // Default view: actionable category only. Toggling "show informational"
    // drops the category filter so the feed includes trajectory events.
    params.set("category", "actionable");
  }
  params.set("limit", "100");
  const url = `/api/activity${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch activity (${res.status})`);
  return res.json() as Promise<ActivityListResponse>;
}

// ---------------------------------------------------------------------------
// Helpers
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

interface EventStyle {
  icon: string;
  label: string;
  badgeClass: string;
}

function eventStyle(type: SystemEventType): EventStyle {
  switch (type) {
    case "ask.created":
      return {
        icon: "?",
        label: "Ask created",
        badgeClass: "bg-accent text-accent-foreground",
      };
    case "task.auto_created":
      return {
        icon: "+",
        label: "Task auto-filed",
        badgeClass: "bg-secondary text-secondary-foreground",
      };
    case "pr.review_posted":
      return {
        icon: "R",
        label: "Review posted",
        badgeClass: "bg-muted text-muted-foreground",
      };
    case "subagent.failed":
      return {
        icon: "!",
        label: "Subagent failed",
        badgeClass: "bg-destructive text-destructive-foreground",
      };
    case "embeddings.provider_degraded":
      return {
        icon: "~",
        label: "Embeddings degraded",
        badgeClass: "bg-destructive text-destructive-foreground",
      };
    case "task.status_changed":
      return {
        icon: ">",
        label: "Task status changed",
        badgeClass: "bg-muted text-muted-foreground",
      };
    case "pr.merged":
      return {
        icon: "M",
        label: "PR merged",
        badgeClass: "bg-muted text-muted-foreground",
      };
    case "subagent.completed":
      return {
        icon: "*",
        label: "Subagent completed",
        badgeClass: "bg-muted text-muted-foreground",
      };
    case "session.started":
      return {
        icon: "S",
        label: "Session started",
        badgeClass: "bg-muted text-muted-foreground",
      };
  }
}

function eventSummary(event: SystemEvent): string {
  const p = event.payload;
  switch (event.eventType) {
    case "ask.created":
      return `${String(p.kind ?? "ask")}: ${String(p.title ?? "(untitled)")}`;
    case "task.auto_created":
      return `${String(p.createdBy ?? "sweeper")} filed: ${String(p.title ?? "(untitled)")}`;
    case "pr.review_posted":
      return `PR #${String(p.prNumber ?? "?")} — ${String(p.state ?? "review")} by ${String(p.reviewer ?? "bot")}`;
    case "subagent.failed":
      return `${String(p.agentType ?? "agent")} on ${String(p.taskId ?? "?")} — ${String(p.outcome ?? "failed")}`;
    case "embeddings.provider_degraded":
      return `${String(p.provider ?? "provider")} degraded — ${String(p.degradedReason ?? p.errorCode ?? "error")}`;
    case "task.status_changed":
      return `${String(p.taskId ?? "?")}: ${String(p.previousStatus ?? "?")} → ${String(p.newStatus ?? "?")}`;
    case "pr.merged":
      return `PR #${String(p.prNumber ?? "?")} merged${p.taskId ? ` (${String(p.taskId)})` : ""}`;
    case "subagent.completed":
      return `${String(p.agentType ?? "agent")} on ${String(p.taskId ?? "?")} — ${String(p.outcome ?? "completed")}`;
    case "session.started":
      return `Session started${p.taskId ? ` for ${String(p.taskId)}` : ""}`;
  }
}

// ---------------------------------------------------------------------------
// Event row
// ---------------------------------------------------------------------------

function EventRow({ event }: { event: SystemEvent }) {
  const style = eventStyle(event.eventType);

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 rounded-md",
        "border border-border bg-card"
      )}
    >
      <span
        className={cn(
          "w-6 h-6 flex items-center justify-center rounded text-xs font-bold flex-shrink-0",
          style.badgeClass
        )}
      >
        {style.icon}
      </span>

      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">{eventSummary(event)}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">{style.label}</span>
          {event.relatedTaskId && (
            <span className="text-xs font-mono text-muted-foreground">{event.relatedTaskId}</span>
          )}
          {event.actor && (
            <span className="text-xs text-muted-foreground truncate max-w-[150px]">
              {event.actor}
            </span>
          )}
        </div>
      </div>

      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums w-14 text-right">
        {formatRelative(event.createdAt)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

const EVENT_TYPES: { value: string; label: string }[] = [
  { value: "all", label: "All events" },
  // actionable
  { value: "ask.created", label: "Asks" },
  { value: "task.auto_created", label: "Auto-filed tasks" },
  { value: "pr.review_posted", label: "PR reviews" },
  { value: "subagent.failed", label: "Subagent failures" },
  { value: "embeddings.provider_degraded", label: "Embeddings degraded" },
  // informational / trajectory
  { value: "task.status_changed", label: "Task status changes" },
  { value: "pr.merged", label: "PR merges" },
  { value: "subagent.completed", label: "Subagent completions" },
  { value: "session.started", label: "Session starts" },
];

export function ActivityPage() {
  const [filterType, setFilterType] = useState("all");
  // Default read-scope is the actionable category; informational/trajectory
  // events are persisted but hidden until the operator opts in (mt#2340).
  const [showInformational, setShowInformational] = useState(false);

  const query = useQuery<ActivityListResponse, Error>({
    queryKey: ["activity", filterType, showInformational],
    queryFn: () => fetchActivity(filterType, showInformational),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const events = query.data?.events ?? [];

  if (query.isError) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <p className="text-sm text-destructive">Failed to load activity: {query.error.message}</p>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-5xl mx-auto w-full space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-base font-semibold text-foreground">
          Activity
          {events.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {events.length} event{events.length !== 1 ? "s" : ""}
            </span>
          )}
        </h1>

        <div className="flex items-center gap-3">
          <label
            className={cn(
              "flex items-center gap-1.5 text-xs text-muted-foreground select-none",
              filterType !== "all" && "opacity-40"
            )}
            title={
              filterType !== "all"
                ? "Not applied while a specific event type is selected"
                : "Include informational / trajectory events (task status changes, merges, session starts)"
            }
          >
            <input
              type="checkbox"
              checked={showInformational}
              disabled={filterType !== "all"}
              onChange={(e) => setShowInformational(e.target.checked)}
              className="accent-current"
              aria-label="Show informational events"
            />
            Show informational
          </label>

          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by event type"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading...</p>
      ) : events.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm font-medium text-foreground">No events yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {filterType !== "all"
                ? "No events match your filter."
                : "Events will appear here as the system operates."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
