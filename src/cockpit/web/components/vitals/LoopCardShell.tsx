/**
 * LoopCardShell — shared presentational frame for the /vitals four loop
 * cards (mt#2601): ring + sparkline + status line, in a fixed layout so each
 * loop card only supplies its own data-fetching + derived values.
 *
 * Mobile-first: stacks to a single column at 390px width (VitalsPage's grid
 * handles column count); this shell itself makes no width assumptions beyond
 * `w-full` + `min-w-0`, so it never forces horizontal scroll inside a narrow
 * flex/grid parent.
 *
 * Status line gets the FULL card width on its own row (not squeezed into the
 * same narrow column as the sparkline) and wraps instead of truncating: an
 * earlier version put ring+sparkline+status in one row and truncated the
 * status text, which silently cut off the honest-gap citations (e.g.
 * "...not yet tracked (mt#2537)") — the opposite of the truthfulness
 * discipline this page exists to demonstrate. Caught during 390x844/1440x900
 * visual verification (mt#2601).
 */
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { cn } from "../../lib/utils";

export interface LoopCardShellProps {
  label: string;
  ring: ReactNode;
  sparkline: ReactNode;
  /** One-line human-readable status, e.g. "3 ready, 1 in review". */
  statusLine: ReactNode;
  /** True when this loop needs operator attention — draws a highlighted border. */
  needsAttention?: boolean;
  className?: string;
}

export function LoopCardShell({
  label,
  ring,
  sparkline,
  statusLine,
  needsAttention = false,
  className,
}: LoopCardShellProps) {
  return (
    <Card
      className={cn(
        "w-full min-w-0",
        needsAttention && "border-[oklch(var(--vsm-seam)/0.6)]",
        className
      )}
      data-testid={`loop-card-${label.toLowerCase()}`}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <div className="shrink-0">{ring}</div>
          <div className="min-w-0 flex-1">{sparkline}</div>
        </div>
        <div className="text-xs leading-snug text-muted-foreground break-words">
          {statusLine}
        </div>
      </CardContent>
    </Card>
  );
}
