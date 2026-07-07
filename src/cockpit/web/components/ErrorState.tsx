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
  /**
   * Error whose message is appended after `prefix`. Typed `unknown` because
   * TanStack Query surfaces `query.error` loosely and non-Error throwables
   * (strings, plain objects) must not silently lose their detail.
   */
  error?: unknown;
  /** Human-readable lead-in combined with `error` (e.g. "Failed to load activity"). */
  prefix?: string;
  /** Call-site density; see LoadingState for the same convention. */
  variant?: "inline" | "page";
  className?: string;
}

function toErrorMessage(error: unknown): string | undefined {
  if (error == null) return undefined;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function ErrorState({ message, error, prefix, variant = "inline", className }: ErrorStateProps) {
  const errorMessage = toErrorMessage(error);
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
