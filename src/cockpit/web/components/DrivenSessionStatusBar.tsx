/**
 * DrivenSessionStatusBar (mt#2751, Rung 2B) — connecting / live / exited
 * (with result summary) / crashed status for a driven session (mt#2751
 * success criterion 4). The `live` state uses the shared emerald live-dot
 * convention (`WorkspaceDetailPage.tsx`'s "Conversation" live indicator, the
 * `cockpit-bundle` CLAUDE.md streaming-indicator convention).
 *
 * @see mt#2751 — this component
 * @see ../hooks/useDrivenSession.ts — supplies `status`/`resultSummary`/`errorMessage`
 * @see ../pages/DrivenSessionPage.tsx — hosts this alongside ConversationView + composer
 */
import { cn } from "../lib/utils";
import type { DrivenSessionStatus } from "../hooks/useDrivenSession";
import type { DrivenSessionResultSummary } from "../lib/driven-session-accumulator";
import { classifyOutcome, isTerminalSessionDriverStatus } from "../lib/conversation-outcome";

export interface DrivenSessionStatusBarProps {
  status: DrivenSessionStatus;
  resultSummary?: DrivenSessionResultSummary | null;
  errorMessage?: string | null;
  className?: string;
}

/**
 * Labels for the TRANSPORT states only (mt#3132).
 *
 * The three terminal states — `exited` / `crashed` / `unrecoverable` — are no
 * longer labeled here. They are terminal CONDITIONS, and their vocabulary now
 * comes from the shared classifier in `../lib/conversation-outcome.ts`, the
 * same one the transcript path's per-turn Outcome chip reads. Before mt#3132
 * this bar and that chip named the same conditions differently, which is the
 * per-pipeline drift the unification removes.
 *
 * Transport states stay local because they are NOT outcomes: a channel
 * reconnecting says nothing about how the conversation ended, and folding them
 * into an outcome vocabulary would be the category error the two-axis model
 * exists to prevent.
 */
const TRANSPORT_LABEL: Record<"connecting" | "live" | "reconnecting", string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
};

/**
 * `unrecoverable` classifies as `Crashed` like any other crash, but it carries
 * one extra fact the shared vocabulary has no value for: this session can never
 * be resumed (mt#3038 R1 delta #2 — read-only history from here on). Rendering
 * it as a modifier keeps that distinction visible without inventing a seventh
 * outcome value that only one pipeline could ever produce.
 */
const NOT_RESUMABLE_NOTE = "not resumable";

function statusLabel(status: DrivenSessionStatus): string {
  if (isTerminalSessionDriverStatus(status)) {
    // Non-null by construction: the session driver arm always classifies.
    return classifyOutcome({ source: "sessionDriver", status }) as string;
  }
  return TRANSPORT_LABEL[status];
}

function formatResultSummary(summary: DrivenSessionResultSummary | null | undefined): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  if (typeof summary.durationMs === "number") parts.push(`${(summary.durationMs / 1000).toFixed(1)}s`);
  if (typeof summary.totalCostUsd === "number") parts.push(`$${summary.totalCostUsd.toFixed(4)}`);
  if (typeof summary.numTurns === "number") {
    parts.push(`${summary.numTurns} turn${summary.numTurns === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function DrivenSessionStatusBar({
  status,
  resultSummary,
  errorMessage,
  className,
}: DrivenSessionStatusBarProps) {
  const summaryText = formatResultSummary(resultSummary);
  return (
    <div className={cn("flex items-center gap-2 text-sm", className)} role="status">
      {status === "live" ? (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"
          aria-label="live"
        />
      ) : (
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            (status === "connecting" || status === "reconnecting") &&
              "bg-muted-foreground/50 animate-pulse",
            status === "exited" && "bg-muted-foreground",
            (status === "crashed" || status === "unrecoverable") && "bg-destructive"
          )}
          aria-hidden
        />
      )}
      <span
        className={cn(
          "font-medium",
          (status === "crashed" || status === "unrecoverable") && "text-destructive",
          status === "live" && "text-emerald-500"
        )}
      >
        {statusLabel(status)}
      </span>
      {status === "unrecoverable" && (
        <span className="text-muted-foreground">· {NOT_RESUMABLE_NOTE}</span>
      )}
      {status === "exited" && summaryText && <span className="text-muted-foreground">{summaryText}</span>}
      {(status === "crashed" || status === "unrecoverable") && errorMessage && (
        <span className="text-destructive">{errorMessage}</span>
      )}
    </div>
  );
}
