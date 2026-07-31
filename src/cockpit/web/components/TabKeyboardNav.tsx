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
 * yield to typing.
 *
 * A deliberate SUPERSET of the guard in `pages/SessionFilmPage.tsx:201-205`,
 * which tests `INPUT`/`TEXTAREA` only — this adds `SELECT` (typeahead selects a
 * matching option, so a swallowed keystroke changes a value) and
 * `isContentEditable` (which covers a rich-text host and, because it is
 * inherited, any node nested inside one). Not "mirrors": the two will not stay
 * identical, and the source of truth for THIS binding set is here.
 *
 * Exported for the seam unification described in mt#3469's spec: mt#3464 is
 * concurrently landing the cockpit's other non-⌘K shortcut with a guard of its
 * own, and whichever of the two merges second hoists one of these into a shared
 * module and deletes the other. Until then, deliberately duplicated rather than
 * hoisted, so the two PRs cannot collide on a new shared file.
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
      if (isTextEntryTarget(e.target)) return;

      // Each binding matches its EXACT modifier set rather than sitting behind
      // one blanket "any unexpected modifier bails" gate. A global early-return
      // on `altKey` would have read as disabling every shortcut whenever Option
      // or AltGr is down — AltGr reports as Ctrl+Alt on international layouts —
      // and would pre-empt any future Alt-based binding for no stated reason.
      // Requiring the exact set achieves the same non-interference locally, and
      // says what each chord actually IS.

      // ⌃Tab / ⌃⇧Tab — recency order. Held cycles walk a frozen snapshot; the
      // keyup handler below releases it.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        activateRelativeTab(e.shiftKey ? "prev" : "next", "mru");
        return;
      }

      // ⌘⇧[ / ⌘⇧] — strip order. Stateless: nothing to release afterwards.
      if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
        // `code` names the physical key and is what this matches. The `key`
        // fallback applies ONLY when `code` is absent: on a layout where the
        // bracket characters live on other physical keys, trusting `key` would
        // fire the binding from whichever key happens to produce "]" — a
        // misfire, not a fallback. An empty `code` means the browser gave us
        // nothing better to go on.
        const noCode = !e.code;
        const isNext = e.code === "BracketRight" || (noCode && (e.key === "]" || e.key === "}"));
        const isPrev = e.code === "BracketLeft" || (noCode && (e.key === "[" || e.key === "{"));
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
