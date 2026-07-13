/**
 * LoadingState — shared loading placeholder for TanStack Query call sites (mt#2616).
 *
 * Before this, ~14 files hand-rolled inline "Loading…" text with slightly
 * different markup (`text-muted-foreground text-sm` vs `text-sm text-muted-foreground`,
 * some with `py-8 text-center`, some without `aria-live`). This component is the
 * single semantic-token, dark-mode-first primitive every `query.isLoading` /
 * `query.isPending` branch should render.
 *
 * Two variants cover the two call-site shapes observed across the codebase:
 *   - `inline` (default) — widget-body density, no vertical padding. Matches
 *     the convention used inside `WidgetShell` bodies (SessionDetail, TaskDetail,
 *     ContextInspector, Credentials, ...).
 *   - `page`   — centered with generous vertical padding, for full-route pages
 *     (ActivityPage, AsksPage, ChangesetsPage, EmbeddingsPage, ...).
 */
import { cn } from "../lib/utils";

export interface LoadingStateProps {
  /** Message shown to the operator. Defaults to "Loading…". */
  message?: string;
  /** Call-site density; see module doc above. */
  variant?: "inline" | "page";
  className?: string;
}

export function LoadingState({ message = "Loading…", variant = "inline", className }: LoadingStateProps) {
  return (
    <p
      className={cn("text-sm text-muted-foreground", variant === "page" && "py-8 text-center", className)}
      aria-live="polite"
    >
      {message}
    </p>
  );
}
