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
 *
 * `collapsed` (mt#3700) renders the icon-rail form: the Plus alone, with the
 * label moved into `aria-label` so the accessible name is unchanged between the
 * two states. The error alert renders in BOTH — a failed launch has no other
 * surface, which is the PR #2477 R1 lesson, and 56px of wrapped destructive text
 * is a worse read than an unwrapped one but an infinitely better one than
 * silence.
 */
import { Plus } from "lucide-react";
import { cn } from "../lib/utils";
import { useNewConversation } from "../hooks/useNewConversation";
import {
  NEW_CONVERSATION_DESCRIPTION,
  NEW_CONVERSATION_HINT,
  NEW_CONVERSATION_LABEL,
} from "../lib/new-conversation";

export function NewConversationButton({ collapsed = false }: { collapsed?: boolean }) {
  const { start, isPending, isError, error } = useNewConversation();

  return (
    <div className={cn("flex flex-shrink-0 flex-col gap-1 pt-2", collapsed ? "px-1" : "px-2")}>
      <button
        type="button"
        title={
          collapsed
            ? `${NEW_CONVERSATION_LABEL} (${NEW_CONVERSATION_HINT}) — ${NEW_CONVERSATION_DESCRIPTION}`
            : NEW_CONVERSATION_DESCRIPTION
        }
        // Collapsed, the visible label is gone, so the accessible name has to be
        // supplied explicitly. Expanded it is omitted so the text node remains
        // the single source of the name.
        aria-label={collapsed ? NEW_CONVERSATION_LABEL : undefined}
        aria-keyshortcuts="Meta+Shift+O"
        disabled={isPending}
        // Deliberately does NOT close the mobile drawer here (PR #2477 R1).
        // The alert below is the only surface a launch failure has, and in the
        // drawer it is the only MOUNTED one — the desktop rail is `hidden`
        // below `md`, so its copy renders into a display:none subtree. Closing
        // on click therefore made a failed launch invisible on mobile, which
        // is exactly the silent failure this component exists to prevent.
        // Nothing is lost on the success path: `Rail` already closes the
        // drawer on every pathname change, and a successful launch navigates
        // to /driven/:id.
        onClick={start}
        className={cn(
          "flex w-full items-center rounded-md py-2 text-sm font-medium transition-colors",
          collapsed ? "justify-center px-0" : "gap-2 px-2.5",
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
        {!collapsed && (
          <>
            <span className="truncate">{isPending ? "Starting…" : NEW_CONVERSATION_LABEL}</span>
            <kbd
              aria-hidden
              className="ml-auto rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {NEW_CONVERSATION_HINT}
            </kbd>
          </>
        )}
      </button>
      {isError && (
        <span
          role="alert"
          className={cn("text-xs text-destructive", collapsed ? "px-0 break-words" : "px-0.5")}
        >
          {error?.message ?? "Failed to start a conversation"}
        </span>
      )}
    </div>
  );
}
