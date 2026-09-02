/**
 * ProjectBadge — compact project-identity chip for all-projects list rows
 * (mt#4729).
 *
 * Purely presentational: callers decide WHETHER to render it
 * (`shouldShowProjectIndicator`, `../lib/project-context`) and WHAT label to
 * pass (`projectLabelById` for uuid-keyed rows, or a raw `repoName` string
 * for session/changeset rows that already carry one). Kept as a standalone
 * component rather than folded into `status-colors.ts`'s badge pattern
 * because it renders project IDENTITY, not workflow state — a different
 * axis with its own (neutral, non-status) color, per `docs/design-system.md`
 * §4's "No shared Badge/chip primitive" gap note: this does not attempt to
 * fill that gap, it is one more per-call-site chip following the same
 * `text-small px-1.5 py-0.5 rounded-full` shape already used by
 * `TaskList.tsx`'s `StatusBadge` and `Attention.tsx`'s kind badge.
 *
 * Semantic tokens only (`bg-secondary`/`text-secondary-foreground`) — this is
 * classification, not a health/status signal, so it does not qualify for the
 * blessed raw-palette healthy/warning exception (design-system.md §5.2).
 */
import { cn } from "../lib/utils";

export function ProjectBadge({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "text-small px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap",
        "bg-secondary text-secondary-foreground",
        "max-w-[10rem] truncate inline-block align-bottom",
        className
      )}
      title={label}
    >
      {label}
    </span>
  );
}
