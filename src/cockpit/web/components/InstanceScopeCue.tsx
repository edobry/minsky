/**
 * InstanceScopeCue — the standard "instance-level surface" marker (mt#4773).
 *
 * Deliberately-global pages (`/proposals`, `/embeddings`, `/interceptors`,
 * `/protection`, `/settings`, the vitals LEARNING/DEPLOY cards, the home
 * substrate band — each re-affirmed global by the mt#4757 audit against the
 * mt#4730 scope census) render full instance content whatever project filter
 * is active. Without a cue, an operator filtered to a near-empty project
 * cannot tell scoped-leak from global-by-design. This is that cue: one shared
 * component, rendered by each such surface, visible ONLY while a specific
 * project is selected — under "All projects" there is nothing to disambiguate,
 * so it renders nothing (mission-control density: no indicator with no useful
 * state to convey, same rule as `shouldShowProjectIndicator`).
 *
 * It reads the selection itself via `useProject()` so adopting surfaces add a
 * single JSX tag. That encapsulation is also census-load-bearing: several
 * adopters sit on `FRONTEND_SCOPE_ALLOWLIST` as deliberately-unscoped fetch
 * sites, and the census's staleness check reads file-level `useProject(`
 * evidence — a hook call added to those files for THIS unrelated concern
 * would false-positive it (the exact shape `components/Rail.tsx`'s by-name
 * exemption exists for). Keeping the hook in here means adopting a cue never
 * changes a page's census evidence.
 *
 * This states surface IDENTITY (like `ProjectBadge`), not a warning: semantic
 * muted tokens, no status color.
 */
import { Globe } from "lucide-react";
import { useOptionalProject, projectLabelBySlug } from "../lib/project-context";
import { cn } from "../lib/utils";

export function InstanceScopeCue({
  className,
  compact = false,
}: {
  className?: string;
  /**
   * Card-header form: icon + two words, full sentence in the tooltip. For
   * surfaces where the standard line would out-weigh the content it annotates
   * (the vitals LEARNING/DEPLOY cards).
   */
  compact?: boolean;
}) {
  const project = useOptionalProject();
  const selectedSlug = project?.selectedSlug ?? null;
  if (selectedSlug === null) return null;
  const label = projectLabelBySlug(project?.projects ?? [], selectedSlug) ?? selectedSlug;
  const sentence = `Instance-level surface — not filtered by the ${label} project selection.`;
  if (compact) {
    return (
      <span
        className={cn(
          "flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap",
          className
        )}
        title={sentence}
        data-testid="instance-scope-cue"
      >
        <Globe aria-hidden className="h-3 w-3 flex-shrink-0" />
        instance-level
      </span>
    );
  }
  return (
    <div
      className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}
      data-testid="instance-scope-cue"
    >
      <Globe aria-hidden className="h-3 w-3 flex-shrink-0" />
      <span>{sentence}</span>
    </div>
  );
}
