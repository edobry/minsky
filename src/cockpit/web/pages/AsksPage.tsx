/**
 * AsksPage — full-page route for managing pending Asks (/asks).
 *
 * The Attention widget on the homepage is the digest ("you have N pending");
 * this page is the management surface where the operator responds, defers,
 * or escalates asks.
 *
 * Self-fetching via TanStack Query against GET /api/asks.
 * Uses useListControls for pagination, filtering, and sorting.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { useListControls, type SortDir } from "../lib/useListControls";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Types — mirrors of server Ask shape (no server imports on frontend)
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

interface AskItem {
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

interface AsksListResponse {
  asks: AskItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchAsks(): Promise<AsksListResponse> {
  const res = await fetch("/api/asks");
  if (!res.ok) throw new Error(`Failed to fetch asks (${res.status})`);
  return res.json() as Promise<AsksListResponse>;
}

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

async function deferAsk(id: string): Promise<void> {
  const res = await fetch(`/api/asks/${id}/defer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`defer failed (${res.status}): ${text}`);
  }
}

async function escalateAsk(id: string): Promise<void> {
  const res = await fetch(`/api/asks/${id}/escalate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`escalate failed (${res.status}): ${text}`);
  }
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

interface KindStyle {
  badge: string;
  label: string;
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

const KIND_PRIORITY: Record<AskKind, number> = {
  "stuck.unblock": 1,
  "authorization.approve": 2,
  "direction.decide": 3,
  "quality.review": 4,
  "coordination.notify": 5,
  "capability.escalate": 6,
  "information.retrieve": 7,
};

// ---------------------------------------------------------------------------
// Filter / sort types
// ---------------------------------------------------------------------------

type SortKey = "age" | "priority" | "kind";

interface Filters {
  kind: string;
  requestor: string;
}

// ---------------------------------------------------------------------------
// Ask detail panel
// ---------------------------------------------------------------------------

interface AskDetailProps {
  ask: AskItem;
  onResolve: (ask: AskItem, optionLetter: string) => void;
  onDefer: (ask: AskItem) => void;
  onEscalate: (ask: AskItem) => void;
  resolving: boolean;
  onClose: () => void;
}

function AskDetail({ ask, onResolve, onDefer, onEscalate, resolving, onClose }: AskDetailProps) {
  const ks = kindStyle(ask.kind);
  const deadlineStr = formatDeadlineRemaining(ask.deadline);
  const isOverdue = deadlineStr === "overdue";

  const hasOptions =
    (ask.options && ask.options.length > 0) ||
    ask.kind === "authorization.approve" ||
    ask.kind === "quality.review";

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const optionCount = ask.options
    ? Math.min(ask.options.length, letters.length)
    : hasOptions
      ? 2
      : 0;

  return (
    <Card className="border-border">
      <CardContent className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${ks.badge}`}>
                {ks.priority} {ask.kind}
              </span>
              {deadlineStr && (
                <span
                  className={`text-xs tabular-nums ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}
                >
                  {deadlineStr}
                </span>
              )}
            </div>
            <h3 className="text-sm font-semibold text-foreground">{ask.title}</h3>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="flex-shrink-0">
            Back
          </Button>
        </div>

        {/* Question */}
        <div className="rounded-md bg-muted/40 p-3">
          <p className="text-sm text-foreground leading-relaxed">{ask.question}</p>
        </div>

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div>
            <span className="font-medium">From:</span>{" "}
            <span className="font-mono">{ask.requestor}</span>
          </div>
          <div>
            <span className="font-medium">Age:</span> <span>{formatRelative(ask.createdAt)}</span>
          </div>
          {ask.parentTaskId && (
            <div>
              <span className="font-medium">Task:</span>{" "}
              <span className="font-mono">{ask.parentTaskId}</span>
            </div>
          )}
          {ask.windowKey && (
            <div>
              <span className="font-medium">Window:</span>{" "}
              <span className="font-mono">{ask.windowKey}</span>
            </div>
          )}
          {ask.windowMissedCount > 0 && (
            <div className="text-destructive/80">Missed {ask.windowMissedCount}x</div>
          )}
        </div>

        {/* Context refs */}
        {ask.contextRefs && ask.contextRefs.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Context:</p>
            {ask.contextRefs.map((ref, i) => (
              <div key={i} className="text-xs text-muted-foreground pl-2 border-l-2 border-border">
                <span className="font-medium">{ref.kind}:</span>{" "}
                <span className="font-mono">{ref.ref}</span>
                {ref.description && (
                  <span className="ml-1 text-muted-foreground/70"> — {ref.description}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Options / response affordances */}
        {hasOptions && (
          <div className="space-y-2">
            {ask.options && ask.options.length > 0 && (
              <div className="space-y-1">
                {ask.options.map((opt, i) => {
                  const letter = letters[i] ?? "?";
                  return (
                    <div key={String(opt.value ?? i)} className="flex items-start gap-2 text-sm">
                      <span className="font-mono text-muted-foreground w-5 flex-shrink-0">
                        {letter})
                      </span>
                      <div>
                        <span className="text-foreground font-medium">{opt.label}</span>
                        {opt.description && (
                          <span className="ml-1 text-muted-foreground text-xs">
                            {" "}
                            — {opt.description}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!ask.options && ask.kind === "authorization.approve" && (
              <div className="text-sm text-muted-foreground">
                <p>A) Approve &nbsp; B) Deny</p>
              </div>
            )}
            {!ask.options && ask.kind === "quality.review" && (
              <div className="text-sm text-muted-foreground">
                <p>A) Approve &nbsp; B) Request changes</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              {Array.from({ length: optionCount }, (_, i) => {
                const letter = letters[i] ?? "?";
                const optLabel = ask.options?.[i]?.label ?? (i === 0 ? "Approve" : "Deny");
                return (
                  <Button
                    key={letter}
                    variant="outline"
                    size="sm"
                    disabled={resolving}
                    onClick={() => onResolve(ask, letter)}
                  >
                    {letter}) {optLabel}
                  </Button>
                );
              })}
              <Button
                variant="outline"
                size="sm"
                disabled={resolving}
                onClick={() => onDefer(ask)}
                className="text-muted-foreground"
              >
                Defer
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={resolving}
                onClick={() => onEscalate(ask)}
                className="text-muted-foreground"
              >
                Escalate
              </Button>
            </div>
          </div>
        )}

        {!hasOptions && (
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={resolving}
              onClick={() => onDefer(ask)}
              className="text-muted-foreground"
            >
              Defer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={resolving}
              onClick={() => onEscalate(ask)}
              className="text-muted-foreground"
            >
              Escalate
            </Button>
            <p className="text-xs text-muted-foreground italic self-center">
              No response options — defer/escalate or resolve via CLI.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Ask row (list item)
// ---------------------------------------------------------------------------

interface AskRowProps {
  ask: AskItem;
  onClick: () => void;
}

function AskRow({ ask, onClick }: AskRowProps) {
  const ks = kindStyle(ask.kind);
  const deadlineStr = formatDeadlineRemaining(ask.deadline);
  const isOverdue = deadlineStr === "overdue";

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md",
        "border border-border bg-card hover:bg-muted/40 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${ks.badge}`}>
        {ks.priority}
      </span>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{ask.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">{ask.kind}</span>
          {ask.parentTaskId && (
            <span className="text-xs font-mono text-muted-foreground">{ask.parentTaskId}</span>
          )}
        </div>
      </div>

      <span className="text-xs text-muted-foreground font-mono flex-shrink-0 max-w-[120px] truncate hidden sm:block">
        {ask.requestor}
      </span>

      {deadlineStr && (
        <span
          className={`text-xs flex-shrink-0 tabular-nums ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}
        >
          {deadlineStr}
        </span>
      )}

      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums w-14 text-right">
        {formatRelative(ask.createdAt)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function AsksPage() {
  const queryClient = useQueryClient();
  const [selectedAskId, setSelectedAskId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const query = useQuery<AsksListResponse, Error>({
    queryKey: ["asks"],
    queryFn: fetchAsks,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });

  const asks = query.data?.asks ?? [];

  const uniqueKinds = [...new Set(asks.map((a) => a.kind))].sort();
  const uniqueRequestors = [...new Set(asks.map((a) => a.requestor))].sort();

  const controls = useListControls<AskItem, SortKey, Filters>({
    items: asks,
    defaultPageSize: 25,
    defaultSortKey: "age",
    defaultSortDir: "desc",
    defaultFilters: { kind: "all", requestor: "all" },
    prefix: "asks",
    filterFn: (item, filters) => {
      if (filters.kind !== "all" && item.kind !== filters.kind) return false;
      if (filters.requestor !== "all" && item.requestor !== filters.requestor) return false;
      return true;
    },
    sortFn: (a, b, key, dir) => {
      const mult = dir === "asc" ? 1 : -1;
      switch (key) {
        case "age": {
          const aTime = new Date(a.createdAt).getTime();
          const bTime = new Date(b.createdAt).getTime();
          return (aTime - bTime) * mult;
        }
        case "priority":
          return (KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]) * mult;
        case "kind":
          return a.kind.localeCompare(b.kind) * mult;
        default:
          return 0;
      }
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async ({ ask, optionLetter }: { ask: AskItem; optionLetter: string }) => {
      const letterIndex = optionLetter.charCodeAt(0) - "A".charCodeAt(0);
      let payloadValue: unknown;
      if (ask.options && ask.options.length > 0) {
        const option = ask.options[letterIndex];
        payloadValue = { option: String(option?.value ?? ""), chosen: String(option?.value ?? "") };
      } else {
        payloadValue = { approved: optionLetter === "A" };
      }
      await resolveAsk(ask.id, {
        responder: "operator",
        payload: payloadValue,
        attentionCost: { transport: "inbox", resolvedIn: "inbox" },
      });
    },
    onMutate: ({ ask }) => setResolvingId(ask.id),
    onSettled: () => {
      setResolvingId(null);
      setSelectedAskId(null);
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
    },
  });

  function handleResolve(ask: AskItem, optionLetter: string) {
    resolveMutation.mutate({ ask, optionLetter });
  }

  const deferMutation = useMutation({
    mutationFn: async (askId: string) => {
      await deferAsk(askId);
    },
    onMutate: () => setResolvingId(selectedAskId),
    onSettled: () => {
      setResolvingId(null);
      setSelectedAskId(null);
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
    },
  });

  const escalateMutation = useMutation({
    mutationFn: async (askId: string) => {
      await escalateAsk(askId);
    },
    onMutate: () => setResolvingId(selectedAskId),
    onSettled: () => {
      setResolvingId(null);
      setSelectedAskId(null);
      void queryClient.invalidateQueries({ queryKey: ["asks"] });
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
    },
  });

  function handleDefer(ask: AskItem) {
    deferMutation.mutate(ask.id);
  }

  function handleEscalate(ask: AskItem) {
    escalateMutation.mutate(ask.id);
  }

  const selectedAsk = asks.find((a) => a.id === selectedAskId) ?? null;

  if (query.isError) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <p className="text-sm text-destructive">Failed to load asks: {query.error.message}</p>
      </div>
    );
  }

  if (selectedAsk) {
    return (
      <div className="p-4 max-w-3xl mx-auto w-full">
        <AskDetail
          ask={selectedAsk}
          onResolve={handleResolve}
          onDefer={handleDefer}
          onEscalate={handleEscalate}
          resolving={resolvingId === selectedAsk.id}
          onClose={() => setSelectedAskId(null)}
        />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-5xl mx-auto w-full space-y-3">
      {/* Header + controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-base font-semibold text-foreground">
          Asks
          {controls.filteredCount > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {controls.filteredCount} pending
            </span>
          )}
        </h1>

        <div className="flex items-center gap-2">
          <select
            value={controls.filters.kind}
            onChange={(e) => controls.setFilter("kind", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by kind"
          >
            <option value="all">All kinds</option>
            {uniqueKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <select
            value={controls.filters.requestor}
            onChange={(e) => controls.setFilter("requestor", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by requestor"
          >
            <option value="all">All requestors</option>
            {uniqueRequestors.map((r) => (
              <option key={r} value={r}>
                {r.length > 30 ? r.slice(0, 30) + "..." : r}
              </option>
            ))}
          </select>

          <select
            value={`${controls.sortKey}_${controls.sortDir}`}
            onChange={(e) => {
              const [newKey, newDir] = e.target.value.split("_") as [SortKey, SortDir];
              if (newKey === controls.sortKey && newDir === controls.sortDir) {
                return;
              }
              // setSort(newKey) on a different key always produces defaultSortDir ("desc")
              // setSort(sameKey) toggles direction
              const afterFirstCall: SortDir =
                newKey !== controls.sortKey ? "desc" : controls.sortDir === "asc" ? "desc" : "asc";
              controls.setSort(newKey);
              if (afterFirstCall !== newDir) {
                controls.setSort(newKey);
              }
            }}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Sort order"
          >
            <option value="age_desc">Newest first</option>
            <option value="age_asc">Oldest first</option>
            <option value="priority_asc">Priority (high first)</option>
            <option value="kind_asc">Kind (A-Z)</option>
          </select>

          {controls.hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={controls.clearFilters} className="text-xs">
              Clear
            </Button>
          )}
        </div>
      </div>

      {resolveMutation.isError && (
        <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Resolve failed:{" "}
          {resolveMutation.error instanceof Error ? resolveMutation.error.message : "unknown"}
        </div>
      )}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading...</p>
      ) : controls.filteredCount === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm font-medium text-foreground">No pending asks</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {controls.hasActiveFilters
              ? "No asks match your current filters."
              : "All clear — nothing needs your attention."}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {controls.pageItems.map((ask) => (
            <AskRow key={ask.id} ask={ask} onClick={() => setSelectedAskId(ask.id)} />
          ))}
        </div>
      )}

      {controls.pageCount > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-muted-foreground">
            Page {controls.page} of {controls.pageCount}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={controls.page <= 1}
              onClick={() => controls.setPage(controls.page - 1)}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={controls.page >= controls.pageCount}
              onClick={() => controls.setPage(controls.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
