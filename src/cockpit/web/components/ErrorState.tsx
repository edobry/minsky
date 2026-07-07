/**
 * ErrorState — shared error placeholder for TanStack Query call sites (mt#2616).
 *
 * Companion to LoadingState. Before this, `query.isError` branches hand-rolled
 * text at three different color tokens across the codebase (`text-destructive`,
 * `text-red-400`, plain `text-muted-foreground`) with inconsistent `role="alert"`
 * usage. This component is the single semantic-token primitive: always
 * `text-destructive` (never a raw Tailwind color like `text-red-400`), always
 * `role="alert"` so assistive tech announces the failure.
 *
 * Usage:
 *   <ErrorState prefix="Failed to load activity" error={query.error} />
 *   // -> "Failed to load activity: <error.message>"
 *
 *   <ErrorState message="Task not found." />
 *   // -> static message, no error object needed
 */
import { cn } from "../lib/utils";

export interface ErrorStateProps {
  /** Static message. Takes precedence over `prefix`/`error` when set. */
  message?: string;
  /** Error whose `.message` is appended after `prefix`. */
  error?: Error | string | null;
  /** Human-readable lead-in combined with `error` (e.g. "Failed to load activity"). */
  prefix?: string;
  /** Call-site density; see LoadingState for the same convention. */
  variant?: "inline" | "page";
  className?: string;
}

export function ErrorState({ message, error, prefix, variant = "inline", className }: ErrorStateProps) {
  const errorMessage = typeof error === "string" ? error : (error?.message ?? undefined);
  const text =
    message ??
    (prefix
      ? `${prefix}${errorMessage ? `: ${errorMessage}` : ""}`
      : (errorMessage ?? "Something went wrong."));

  return (
    <p
      role="alert"
      className={cn("text-sm text-destructive", variant === "page" && "py-8 text-center", className)}
    >
      {text}
    </p>
  );
}
