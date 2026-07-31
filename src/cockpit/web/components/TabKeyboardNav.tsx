/**
 * Keyboard navigation over the entity-tab strip (mt#3469).
 *
 * Renders nothing; it exists to own a `window` keydown listener, mounted inside
 * `TabsProvider` so it can reach `useTabs`. Follows the idiom already
 * established by `CommandPalette`'s ⌘K listener rather than introducing a
 * hotkey library for four bindings.
 *
 *   ⌘⇧] / ⌘⇧[        next / previous tab in STRIP order (the iTerm idiom)
 *   ⌃Tab / ⌃⇧Tab     next / previous tab in RECENCY order (the VS Code idiom)
 *
 * ## These only fire inside the Tauri cockpit window
 *
 * A browser reserves these chords for its own tab switching and does not
 * deliver them to the page, so in a browser tab every handler here is simply
 * inert — the intended degradation, and the reason no Tauri-detection or
 * feature flag is needed. Warrant, and which half of that claim is actually
 * vendor-documented, is recorded in mt#3469's spec; do not upgrade it to a
 * verified claim without a real keypress test, because a CDP-injected key
 * bypasses browser chrome and would report a false "delivered".
 *
 * ## Why `event.code` and not `event.key`
 *
 * `⌘⇧]` arrives with `event.key === "}"` on a US layout — Shift has already
 * been applied to the character. Matching `"]"` would therefore never fire.
 * `event.code` names the PHYSICAL key (`BracketRight`) and is unaffected by
 * modifiers, which is what makes it the right thing to match for a chorded
 * binding. `event.key` is kept as a fallback for layouts/browsers that report
 * an empty or non-standard `code`.
 */
import { useEffect } from "react";
import { useTabs } from "../lib/tabs";

/**
 * True when the event's target is a text-entry surface, where a shortcut must
 * yield to typing. Mirrors the guard in `pages/SessionFilmPage.tsx`; when the
 * cockpit consolidates its shortcut handling into one seam (see mt#3469's
 * coordination note with mt#3464) this is the piece to hoist.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function TabKeyboardNav() {
  const { activateRelativeTab, commitTabCycle } = useTabs();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.altKey) return;
      if (isTextEntryTarget(e.target)) return;

      // ⌃Tab / ⌃⇧Tab — recency order. Held cycles walk a frozen snapshot; the
      // keyup handler below releases it.
      if (e.ctrlKey && !e.metaKey && e.key === "Tab") {
        e.preventDefault();
        activateRelativeTab(e.shiftKey ? "prev" : "next", "mru");
        return;
      }

      // ⌘⇧[ / ⌘⇧] — strip order. Stateless: nothing to release afterwards.
      if (e.metaKey && e.shiftKey && !e.ctrlKey) {
        const isNext = e.code === "BracketRight" || e.key === "]" || e.key === "}";
        const isPrev = e.code === "BracketLeft" || e.key === "[" || e.key === "{";
        if (isNext || isPrev) {
          e.preventDefault();
          activateRelativeTab(isNext ? "next" : "prev", "positional");
        }
      }
    }

    // Releasing Control commits the recency cycle: the tab it landed on becomes
    // most-recent, and the frozen order is dropped so the next cycle re-reads
    // the real one. `blur` covers the case where focus leaves the window with
    // the modifier still down, which produces no keyup — without it the
    // suppression flag would stay set and silently stop recency tracking.
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === "Control") commitTabCycle();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", commitTabCycle);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", commitTabCycle);
    };
  }, [activateRelativeTab, commitTabCycle]);

  return null;
}
