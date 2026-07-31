/**
 * NewConversationProvider / useNewConversation — ONE launch call and ONE
 * global shortcut registration shared by every new-conversation surface
 * (mt#3464): the rail control (desktop + mobile drawer), the ⌘K palette
 * action, and the keyboard shortcut.
 *
 * Why a provider rather than each surface calling `useStartDrivenSession`
 * itself — two failure modes a per-surface mutation would ship:
 *   1. **Silent failure.** A launch started from the shortcut or the palette
 *      would own a mutation instance nothing renders, so its error would go
 *      nowhere. Sharing one instance means any failure lands in the rail
 *      control's alert regardless of which surface triggered it.
 *   2. **Double registration.** The rail renders in two places (the desktop
 *      `<aside>` and the mobile drawer, both mounted while the drawer is
 *      open). A `window` keydown listener registered per-surface would fire
 *      twice and start two conversations from one keypress. The listener
 *      lives here, on the single provider mounted by `Layout`.
 *
 * Thin wrapper over `useStartDrivenSession` (mt#2752) rather than a second
 * launch path: it fixes the input to `{}` (untasked — daemon repo cwd, no
 * task binding) and drops a launch requested while one is already in flight.
 * Navigation to `/driven/:id` and the `["agents"]` cache invalidation stay the
 * underlying mutation's job.
 *
 * The task-bound launch (`{ taskId }`) deliberately does NOT route through
 * here — it lives on the task detail page and passes its own input.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useStartDrivenSession } from "./useStartDrivenSession";
import { matchesNewConversationShortcut } from "../lib/new-conversation";

export interface NewConversationValue {
  /** Launch an untasked conversation. No-op while a launch is in flight. */
  start: () => void;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
}

const NewConversationContext = createContext<NewConversationValue | null>(null);

export function NewConversationProvider({ children }: { children: ReactNode }) {
  const mutation = useStartDrivenSession();
  const { mutate, isPending, isError, error } = mutation;

  const start = useCallback(() => {
    if (isPending) return;
    mutate({});
  }, [mutate, isPending]);

  // The single global shortcut registration. `matchesNewConversationShortcut`
  // owns both the chord and the text-entry guard, so the shortcut can be
  // changed (or made a bare key) without touching this listener.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!matchesNewConversationShortcut(e)) return;
      e.preventDefault();
      start();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [start]);

  const value = useMemo<NewConversationValue>(
    () => ({ start, isPending, isError, error }),
    [start, isPending, isError, error]
  );

  return (
    <NewConversationContext.Provider value={value}>{children}</NewConversationContext.Provider>
  );
}

export function useNewConversation(): NewConversationValue {
  const value = useContext(NewConversationContext);
  if (!value) {
    throw new Error(
      "useNewConversation must be used inside <NewConversationProvider> (mounted by Layout)"
    );
  }
  return value;
}
