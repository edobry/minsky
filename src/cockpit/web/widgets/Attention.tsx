/**
 * Attention widget frontend (mt#1147)
 *
 * Renders the active-window cohort of pending operator-routed Asks.
 *
 * Design contract:
 *   - Per spec: priority-sorted, per-task-grouped, humility 5-item checklist.
 *   - CLI sibling (mt#1491 window.service) provides the render-contract reference.
 *   - Per-kind affordances: direction.decide shows options frame, authorization.approve
 *     shows policy-silent reason, quality.review shows diff/output context,
 *     stuck.unblock shows prior attempts.
 *   - Empty state ("no pending asks") is desirable, not an error.
 *   - Mark-resolved: calls asks.respond mutation endpoint, then re-fetches.
 *
 * Transport: TanStack Query polling at 10s (pre-mt#1001).
 * Data source: GET /api/widget/attention/data
 *
 * Types mirror src/cockpit/widgets/attention.ts (no server imports on frontend).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";

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
      return { badge: "bg-destructive text-destructive-foreground", label: "stuck.unblock", priority: "P1" };
    case "authorization.approve":
      return { badge: "bg-destructive/60 text-foreground", label: "authorization.approve", priority: "P2" };
    case "direction.decide":
      return { badge: "bg-accent text-accent-foreground", label: "direction.decide", priority: "P3" };
    case "quality.review":
      return { badge: "bg-secondary text-secondary-foreground", label: "quality.review", priority: "P4" };
    case "coordination.notify":
      return { badge: "bg-muted text-muted-foreground", label: "coordination.notify", priority: "P5" };
    case "capability.escalate":
      return { badge: "bg-muted text-muted-foreground", label: "capability.escalate", priority: "P6" };
    case "information.retrieve":
      return { badge: "bg-muted text-muted-foreground", label: "information.retrieve", priority: "P7" };
  }
}

// ---------------------------------------------------------------------------
// Resolve mutation — calls POST /api/asks/:id/resolve
// ---------------------------------------------------------------------------

async function resolveAsk(id: string, payload: unknown): Promise<void> {
  const res = await fetch(`/api/asks/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`resolve failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Ask-kind renderers
// ---------------------------------------------------------------------------

/** Render the humility 5-item checklist for a single Ask. */
function AskContextSection({ ask }: { ask: AttentionAsk }) {
  // 1. Question
  // 2. Options inline
  // 3. Drivers (from contextRefs)
  // 4. Recommendation marker
  // 5. Not-needed field

  const drivers: string[] = [];
  if (ask.contextRefs && ask.contextRefs.length > 0) {
    drivers.push(...ask.contextRefs.filter((r) => r.description).map((r) => r.description as string));
  }
  if (ask.metadata?.["drivers"] && Array.isArray(ask.metadata["drivers"])) {
    drivers.push(...(ask.metadata["drivers"] as string[]));
  }

  const notNeeded = ask.metadata?.["notNeeded"];
  const priorAttempts = ask.kind === "stuck.unblock" && ask.metadata?.["priorAttempts"];
  const policyReason = ask.kind === "authorization.approve" && ask.metadata?.["policyReason"];

  return (
    <div className="mt-1.5 space-y-1.5 text-sm">
      {/* 1. Question */}
      <p className="text-foreground leading-snug">{ask.question}</p>

      {/* Per-kind: stuck.unblock — show prior attempts */}
      {priorAttempts && (
        <div className="rounded bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
          <span className="font-medium">Prior attempts:</span> {String(priorAttempts)}
        </div>
      )}

      {/* Per-kind: authorization.approve — show policy-silent reason */}
      {policyReason && (
        <div className="rounded bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
          <span className="font-medium">Policy:</span> {String(policyReason)}
        </div>
      )}

      {/* Per-kind: quality.review — show diff/output context */}
      {ask.kind === "quality.review" && ask.contextRefs && ask.contextRefs.filter((r) => r.kind === "diff").map((r) => (
        <div key={r.ref} className="rounded bg-muted/60 px-2 py-1 text-xs font-mono text-muted-foreground truncate">
          <span className="font-medium not-italic">diff:</span> {r.ref}
          {r.description && <span className="ml-1 text-muted-foreground/70"> — {r.description}</span>}
        </div>
      ))}

      {/* 2. Options inline — direction.decide, authorization.approve */}
      {ask.options && ask.options.length > 0 && (
        <ul className="space-y-0.5">
          {ask.options.map((opt, i) => {
            const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            const letter = letters[i] ?? "?";
            const isFirst = i === 0;
            const isRecommended = isFirst && !String(opt.label).toLowerCase().includes("recommended");
            return (
              <li key={String(opt.value ?? i)} className="flex items-start gap-1.5 text-xs">
                <span className="flex-shrink-0 font-medium text-muted-foreground w-4">{letter})</span>
                <span className="text-foreground">
                  {opt.label}
                  {isRecommended && (
                    <span className="ml-1 text-muted-foreground text-xs">(recommended)</span>
                  )}
                  {opt.description && (
                    <span className="ml-1 text-muted-foreground"> — {opt.description}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Synthetic options for approve/review kinds without explicit options */}
      {!ask.options && ask.kind === "authorization.approve" && (
        <ul className="space-y-0.5 text-xs">
          <li className="flex items-start gap-1.5">
            <span className="flex-shrink-0 font-medium text-muted-foreground w-4">A)</span>
            <span>Approve</span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="flex-shrink-0 font-medium text-muted-foreground w-4">B)</span>
            <span>Deny</span>
          </li>
        </ul>
      )}
      {!ask.options && ask.kind === "quality.review" && (
        <ul className="space-y-0.5 text-xs">
          <li className="flex items-start gap-1.5">
            <span className="flex-shrink-0 font-medium text-muted-foreground w-4">A)</span>
            <span>Approve</span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="flex-shrink-0 font-medium text-muted-foreground w-4">B)</span>
            <span>Request changes</span>
          </li>
        </ul>
      )}

      {/* 3. Drivers */}
      {drivers.length > 0 && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Drivers:</span> {drivers.join(", ")}
        </p>
      )}

      {/* 5. Not needed */}
      {notNeeded && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Not needed:</span> {String(notNeeded)}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single Ask card
// ---------------------------------------------------------------------------

interface AskCardProps {
  ask: AttentionAsk;
  index: number;
  onResolve: (ask: AttentionAsk, optionLetter: string) => void;
  resolving: boolean;
}

function AskCard({ ask, index, onResolve, resolving }: AskCardProps) {
  const [expanded, setExpanded] = useState(true);
  const ks = kindStyle(ask.kind);
  const deadlineStr = formatDeadlineRemaining(ask.deadline);
  const ageStr = formatRelative(ask.createdAt);
  const isOverdue = deadlineStr === "overdue";

  const hasOptions = (ask.options && ask.options.length > 0) ||
    ask.kind === "authorization.approve" ||
    ask.kind === "quality.review";

  // Available response letters
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const optionCount = ask.options ? Math.min(ask.options.length, letters.length) : (hasOptions ? 2 : 0);

  return (
    <div className="rounded border border-border bg-card/50 overflow-hidden">
      {/* Ask header row */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/30 select-none"
           onClick={() => setExpanded((v) => !v)}>
        {/* Index */}
        <span className="text-xs font-mono text-muted-foreground w-5 flex-shrink-0 text-right">
          [{index}]
        </span>

        {/* Kind badge */}
        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${ks.badge}`}>
          {ks.priority}
        </span>

        {/* Kind label */}
        <span className="text-xs font-medium text-foreground flex-1 min-w-0 truncate">
          {ask.kind}
        </span>

        {/* Deadline badge */}
        {deadlineStr && (
          <span className={`text-xs flex-shrink-0 tabular-nums ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}>
            {deadlineStr}
          </span>
        )}

        {/* Age */}
        <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
          {ageStr}
        </span>

        {/* Expand chevron */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0 text-muted-foreground transition-transform"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* Ask title */}
      <div className="px-2.5 py-1 border-t border-border/50">
        <p className="text-xs font-medium text-foreground truncate">{ask.title}</p>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="px-2.5 pb-2.5">
          <AskContextSection ask={ask} />

          {/* Requestor + window missed count */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              <span className="font-medium">From:</span>{" "}
              <span className="font-mono">{ask.requestor.length > 40 ? ask.requestor.slice(0, 40) + "…" : ask.requestor}</span>
            </span>
            {ask.windowMissedCount > 0 && (
              <span className="text-destructive/80">
                missed {ask.windowMissedCount}x
              </span>
            )}
          </div>

          {/* Context refs (non-diff) */}
          {ask.contextRefs && ask.contextRefs.filter((r) => r.kind !== "diff").length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {ask.contextRefs.filter((r) => r.kind !== "diff").map((ref, i) => (
                <div key={i} className="text-xs text-muted-foreground">
                  <span className="font-medium">{ref.kind}:</span>{" "}
                  <span className="font-mono">{ref.ref}</span>
                  {ref.description && (
                    <span className="ml-1 text-muted-foreground/70"> — {ref.description}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Response affordances */}
          {hasOptions && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Array.from({ length: optionCount }, (_, i) => {
                const letter = letters[i] ?? "?";
                const optLabel = ask.options?.[i]?.label ?? (i === 0 ? "Approve" : "Deny/Changes");
                return (
                  <button
                    key={letter}
                    disabled={resolving}
                    onClick={(e) => {
                      e.stopPropagation();
                      onResolve(ask, letter);
                    }}
                    className="text-xs px-2 py-0.5 rounded border border-border bg-muted hover:bg-muted/70 text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label={`Respond to ask ${ask.id} with option ${letter}: ${optLabel}`}
                  >
                    {letter}) {optLabel.length > 20 ? optLabel.slice(0, 20) + "…" : optLabel}
                  </button>
                );
              })}
              {/* Defer affordance — v0: informational note */}
              <button
                disabled
                className="text-xs px-2 py-0.5 rounded border border-border/50 bg-muted/30 text-muted-foreground disabled:cursor-not-allowed"
                title="Defer to next window — available post-mt#1488 full wiring"
              >
                defer
              </button>
            </div>
          )}

          {/* Non-respondable kinds — skip-only affordance */}
          {!hasOptions && (
            <p className="mt-1.5 text-xs text-muted-foreground italic">
              No in-widget response for {ask.kind} — acknowledge via CLI (<code>skip</code>) or MCP.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-task group section
// ---------------------------------------------------------------------------

interface TaskGroupProps {
  taskId: string;
  asks: AttentionAsk[];
  globalOffset: number;
  onResolve: (ask: AttentionAsk, optionLetter: string) => void;
  resolvingId: string | null;
}

function TaskGroup({ taskId, asks, globalOffset, onResolve, resolvingId }: TaskGroupProps) {
  return (
    <div className="mb-3 last:mb-0">
      {/* Task section header */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-mono font-medium text-foreground">
          {taskId}
        </span>
        <span className="text-xs text-muted-foreground">
          {asks.length === 1 ? "1 ask" : `${asks.length} asks`}
        </span>
        <div className="flex-1 border-t border-border/40" />
      </div>

      {/* Ask cards */}
      <div className="space-y-1.5 ml-1">
        {asks.map((ask, i) => (
          <AskCard
            key={ask.id}
            ask={ask}
            index={globalOffset + i + 1}
            onResolve={onResolve}
            resolving={resolvingId === ask.id}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cohort view — groups asks by parentTaskId, preserving priority order
// ---------------------------------------------------------------------------

function groupByTask(asks: AttentionAsk[]): Map<string, AttentionAsk[]> {
  const byTask = new Map<string, AttentionAsk[]>();
  const sectionOrder: string[] = [];

  for (const ask of asks) {
    const taskId = ask.parentTaskId ?? "(no task)";
    if (!byTask.has(taskId)) {
      sectionOrder.push(taskId);
    }
    const group = byTask.get(taskId) ?? [];
    group.push(ask);
    byTask.set(taskId, group);
  }

  // Return a new Map in section-order (preserving priority ordering from server)
  const ordered = new Map<string, AttentionAsk[]>();
  for (const key of sectionOrder) {
    const group = byTask.get(key);
    if (group) ordered.set(key, group);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Main widget component — self-fetching via TanStack Query
// ---------------------------------------------------------------------------

async function fetchAttention(): Promise<WidgetData> {
  return fetchWidgetData("attention");
}

export function Attention() {
  const queryClient = useQueryClient();

  const query = useQuery<WidgetData, Error>({
    queryKey: ["attention"],
    queryFn: fetchAttention,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });

  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const resolveMutation = useMutation({
    mutationFn: async ({ ask, optionLetter }: { ask: AttentionAsk; optionLetter: string }) => {
      const letterIndex = optionLetter.charCodeAt(0) - "A".charCodeAt(0);
      let payloadValue: unknown;

      if (ask.options && ask.options.length > 0) {
        const option = ask.options[letterIndex];
        payloadValue = { option: String(option?.value ?? ""), chosen: String(option?.value ?? "") };
      } else {
        // Synthetic approve/deny for authorization.approve / quality.review
        payloadValue = { approved: optionLetter === "A" };
      }

      await resolveAsk(ask.id, {
        responder: "operator",
        payload: payloadValue,
        attentionCost: { transport: "inbox", resolvedIn: "inbox" },
      });
    },
    onMutate: ({ ask }) => {
      setResolvingId(ask.id);
    },
    onSettled: () => {
      setResolvingId(null);
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
    },
  });

  function handleResolve(ask: AttentionAsk, optionLetter: string) {
    resolveMutation.mutate({ ask, optionLetter });
  }

  // Error state
  if (query.isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Attention</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Failed to load attention data: {query.error.message}</p>
        </CardContent>
      </Card>
    );
  }

  // Loading state
  if (query.isLoading || !query.data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Attention</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const data = query.data;

  // Degraded state (server-reported)
  if (data.state === "degraded") {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Attention</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>{data.reason}</p>
        </CardContent>
      </Card>
    );
  }

  // Payload shape guard
  if (!isAttentionPayload(data.payload)) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Attention</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Unexpected payload shape</p>
        </CardContent>
      </Card>
    );
  }

  const { activeWindow, cohort, totalPending } = data.payload;
  const taskGroups = groupByTask(cohort);

  // Compute globalOffset per task group for 1-based indices
  const groupOffsets = new Map<string, number>();
  let offset = 0;
  for (const [taskId, asks] of taskGroups.entries()) {
    groupOffsets.set(taskId, offset);
    offset += asks.length;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base font-semibold">
            Attention
            {totalPending > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {totalPending} pending
              </span>
            )}
          </CardTitle>

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
      </CardHeader>

      <CardContent>
        {cohort.length === 0 ? (
          /* Empty state — desirable, not an error */
          <div className="py-3 text-center">
            <p className="text-sm font-medium text-foreground">No pending asks</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {activeWindow
                ? `Window "${activeWindow.windowKey}" is open — all clear.`
                : "No active window — all clear."}
            </p>
          </div>
        ) : (
          <div>
            {/* Mutation error feedback */}
            {resolveMutation.isError && (
              <div className="mb-2 rounded border border-destructive/50 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                Resolve failed: {resolveMutation.error instanceof Error ? resolveMutation.error.message : "unknown error"}
              </div>
            )}

            {/* Task groups */}
            {Array.from(taskGroups.entries()).map(([taskId, asks]) => (
              <TaskGroup
                key={taskId}
                taskId={taskId}
                asks={asks}
                globalOffset={groupOffsets.get(taskId) ?? 0}
                onResolve={handleResolve}
                resolvingId={resolvingId}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
