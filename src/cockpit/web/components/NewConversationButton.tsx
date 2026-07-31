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
          "bg-primary text-primary-foreground hover:bg-primary/90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
      >
        <Plus aria-hidden className="h-4 w-4 flex-shrink-0" />
        <span className="truncate">{isPending ? "Starting…" : NEW_CONVERSATION_LABEL}</span>
        <kbd
          aria-hidden
          className="ml-auto rounded border border-primary-foreground/30 px-1.5 py-0.5 font-mono text-[10px] text-primary-foreground/80"
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
