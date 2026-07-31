/**
 * NewConversationButton — the persistent create affordance in the rail
 * (mt#3464).
 *
 * Sits in fixed chrome, above the nav sections, on every route: the operator
 * should never have to remember which page starts a conversation. Placed
 * between the project selector and the nav landmark rather than inside it —
 * this is an action, not a destination, and mt#2370 pins the Attention digest
 * at the top of the nav proper.
 *
 * Deliberately not a floating action button: Material scopes the FAB to
 * one-per-screen touch surfaces with no persistent chrome, and cockpit is a
 * dense desktop dashboard that has chrome to spend.
 *
 * The shortcut hint is `aria-hidden` so the button's accessible name stays
 * exactly its label; the launch semantics ride in `title` rather than in the
 * visible text.
 */
import { Plus } from "lucide-react";
import { cn } from "../lib/utils";
import { useNewConversation } from "../hooks/useNewConversation";
import {
  NEW_CONVERSATION_DESCRIPTION,
  NEW_CONVERSATION_HINT,
  NEW_CONVERSATION_LABEL,
} from "../lib/new-conversation";

export function NewConversationButton({
  /** Present only in the mobile drawer — closes it once a launch starts. */
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { start, isPending, isError, error } = useNewConversation();

  return (
    <div className="flex flex-shrink-0 flex-col gap-1 px-2 pt-2">
      <button
        type="button"
        title={NEW_CONVERSATION_DESCRIPTION}
        aria-keyshortcuts="Meta+Shift+O"
        disabled={isPending}
        onClick={() => {
          start();
          onNavigate?.();
        }}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
          // Bordered rather than a solid primary fill: a saturated create
          // button reads as the loudest thing in the rail and out-shouts the
          // Attention digest directly below it — inverting the hierarchy
          // mt#2370 pins that digest at the top to establish. The Plus carries
          // the primary hue; the surface stays quiet.
          "border border-border/60 bg-muted/30 text-foreground hover:bg-muted/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
      >
        <Plus aria-hidden className="h-4 w-4 flex-shrink-0 text-primary" />
        <span className="truncate">{isPending ? "Starting…" : NEW_CONVERSATION_LABEL}</span>
        <kbd
          aria-hidden
          className="ml-auto rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {NEW_CONVERSATION_HINT}
        </kbd>
      </button>
      {isError && (
        <span role="alert" className="px-0.5 text-xs text-destructive">
          {error?.message ?? "Failed to start a conversation"}
        </span>
      )}
    </div>
  );
}
