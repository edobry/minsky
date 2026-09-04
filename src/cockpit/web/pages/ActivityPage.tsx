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
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { EntityRef } from "../components/EntityRef";
import { cn } from "../lib/utils";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import { useProject } from "../lib/project-context";
import { eventStyle, eventSummary } from "../lib/activity-event-render";

// ---------------------------------------------------------------------------
// Types — mirrors of server SystemEvent shape
// ---------------------------------------------------------------------------

/**
 * The wire's event type, as a plain string (mt#4775).
 *
 * This was a 9-member union while the server's `system_event_type` enum had 30,
 * so 21 types rendered as `Unknown event (…)`. Narrowing it bought a
 * compile-time exhaustiveness guard that was sound over the union and vacuous
 * with respect to the server — mt#3240's fallback existed precisely because the
 * two never matched, and `fetchActivity` type-asserts the response rather than
 * validating it, so the narrow type was never a guarantee about the wire.
 *
 * Rendering now lives in `../lib/activity-event-render`, which gives every type
 * a derived label and a payload summary and keeps bespoke copy for the nine.
 * `enum-drift.test.ts` asserts no server type renders as "Unknown".
 */
export type SystemEventType = string;

export interface SystemEvent {
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
  showInformational: boolean,
  queryParam?: { project: string }
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
  if (queryParam) params.set("project", queryParam.project);
  const url = `/api/activity?${params.toString()}`;
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

// ---------------------------------------------------------------------------
// Event row
// ---------------------------------------------------------------------------

// Exported for direct testing (mt#3175) — the entity-reference change lives
// entirely in this row component.
export function EventRow({ event }: { event: SystemEvent }) {
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
            // children mode preserves the exact prior text (no inline label/status
            // chip) so this dense row's line height is unchanged (mt#3175) — hover
            // still surfaces title + status.
            <EntityRef type="task" id={event.relatedTaskId} className="text-xs">
              {event.relatedTaskId}
            </EntityRef>
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
  // mt#4731: `/api/activity` does not yet READ `?project=` server-side (out
  // of this task's scope, matching mt#4727's boundary) — this wiring is
  // forward-compatible with that follow-up landing.
  const { selectedSlug, queryParam } = useProject();

  const query = useQuery<ActivityListResponse, Error>({
    queryKey: ["activity", filterType, showInformational, selectedSlug],
    queryFn: () => fetchActivity(filterType, showInformational, queryParam),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const events = query.data?.events ?? [];

  if (query.isError) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <ErrorState prefix="Failed to load activity" error={query.error} />
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
            <Checkbox
              checked={showInformational}
              disabled={filterType !== "all"}
              onCheckedChange={(v) => setShowInformational(v === true)}
              aria-label="Show informational events"
            />
            Show informational
          </label>

          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger aria-label="Filter by event type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {query.isLoading ? (
        <LoadingState message="Loading..." variant="page" />
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
