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

export interface DrivenSessionStatusBarProps {
  status: DrivenSessionStatus;
  resultSummary?: DrivenSessionResultSummary | null;
  errorMessage?: string | null;
  className?: string;
}

const STATUS_LABEL: Record<DrivenSessionStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  exited: "Exited",
  crashed: "Crashed",
};

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
            status === "connecting" && "bg-muted-foreground/50",
            status === "exited" && "bg-muted-foreground",
            status === "crashed" && "bg-destructive"
          )}
          aria-hidden
        />
      )}
      <span
        className={cn(
          "font-medium",
          status === "crashed" && "text-destructive",
          status === "live" && "text-emerald-500"
        )}
      >
        {STATUS_LABEL[status]}
      </span>
      {status === "exited" && summaryText && <span className="text-muted-foreground">{summaryText}</span>}
      {status === "crashed" && errorMessage && <span className="text-destructive">{errorMessage}</span>}
    </div>
  );
}
