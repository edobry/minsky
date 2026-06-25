/**
 * AskDetail widget + Ask API surface (mt#2410).
 *
 * Extracted verbatim from AsksPage.tsx so the detail body can render in the
 * URL-addressable entity-tab frame (/ask/:id, AskPage) per the mt#2398 PR2
 * unification — sibling of TaskDetail / SessionDetail / MemoryDetail in the
 * widgets/ convention. AsksPage keeps the list; this module owns the shared
 * Ask types, the /api/asks fetch/mutate helpers, the kind styling, and the
 * detail panel component.
 */
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Prose } from "../components/Prose";
import { useEntityIndex } from "../lib/use-entity-index";

// ---------------------------------------------------------------------------
// Types — mirrors of server Ask shape (no server imports on frontend)
// ---------------------------------------------------------------------------

export type AskKind =
  | "capability.escalate"
  | "information.retrieve"
  | "authorization.approve"
  | "direction.decide"
  | "coordination.notify"
  | "quality.review"
  | "stuck.unblock";

export type AskState =
  | "detected"
  | "classified"
  | "routed"
  | "suspended"
  | "responded"
  | "closed"
  | "cancelled"
  | "expired";

export interface AskOption {
  label: string;
  value: unknown;
  description?: string;
}

export interface ContextRef {
  kind: string;
  ref: string;
  description?: string;
}

export interface AskItem {
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

export interface AsksListResponse {
  asks: AskItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export async function fetchAsks(): Promise<AsksListResponse> {
  const res = await fetch("/api/asks");
  if (!res.ok) throw new Error(`Failed to fetch asks (${res.status})`);
  return res.json() as Promise<AsksListResponse>;
}

export async function resolveAsk(id: string, payload: unknown): Promise<void> {
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

export async function deferAsk(id: string): Promise<void> {
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

export async function escalateAsk(id: string): Promise<void> {
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

export function formatRelative(isoTimestamp: string): string {
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

export function formatDeadlineRemaining(isoDeadline: string | undefined): string | null {
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

export interface KindStyle {
  badge: string;
  label: string;
  priority: string;
}

export function kindStyle(kind: AskKind): KindStyle {
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

export const KIND_PRIORITY: Record<AskKind, number> = {
  "stuck.unblock": 1,
  "authorization.approve": 2,
  "direction.decide": 3,
  "quality.review": 4,
  "coordination.notify": 5,
  "capability.escalate": 6,
  "information.retrieve": 7,
};

// ---------------------------------------------------------------------------
// Ask detail panel
// ---------------------------------------------------------------------------

export interface AskDetailProps {
  ask: AskItem;
  onResolve: (ask: AskItem, optionLetter: string) => void;
  onDefer: (ask: AskItem) => void;
  onEscalate: (ask: AskItem) => void;
  resolving: boolean;
  onClose: () => void;
}

export function AskDetail({
  ask,
  onResolve,
  onDefer,
  onEscalate,
  resolving,
  onClose,
}: AskDetailProps) {
  const ks = kindStyle(ask.kind);
  const deadlineStr = formatDeadlineRemaining(ask.deadline);
  const isOverdue = deadlineStr === "overdue";
  const entityIndex = useEntityIndex();

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
          <Prose entityIndex={entityIndex}>{ask.question}</Prose>
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
