/**
 * Rail-collapse affordance — the single definition the rail's toggle button and
 * the global shortcut both read (mt#3700).
 *
 * The desktop rail is a fixed 240px `<aside>` with no way to reclaim its width.
 * On a wide-canvas surface (the conversation film view, the plant board, the
 * task graph) that is permanent navigation chrome competing with the thing the
 * operator opened the cockpit to look at. Collapsing narrows it to a 56px icon
 * rail rather than hiding it outright: a hidden rail needs a floating re-entry
 * control, which is new chrome on exactly the surfaces this exists to declutter,
 * and the expand affordance stays anchored where the collapse happened.
 *
 * Below `md` this is inert — the rail is already a top bar + drawer there
 * (mt#2604), and the drawer always renders the expanded nav.
 *
 * ## Chord choice (⌘B, meta only)
 *
 * Picked for transfer: it is the sidebar toggle in VS Code and in the editors
 * the operator already lives in. It is free against all four shortcuts the
 * cockpit already owns — ⌘K (palette), ⌘⇧O (new conversation, `new-conversation.ts`),
 * and ⌘⇧[ / ⌘⇧] plus ⌃Tab (`TabKeyboardNav.tsx`) — because none of them binds
 * meta+B.
 *
 * `ctrlKey` is deliberately NOT matched, following `new-conversation.ts`: the
 * tray ships for macOS, and binding Ctrl as well would claim a chord on
 * platforms whose browsers may already use it, for no gain here.
 *
 * A browser that binds ⌘B to its own chrome may swallow the keydown before the
 * page sees it (Firefox's bookmarks sidebar is the case to expect). That is a
 * degradation, not a failure mode to design around: the header toggle button is
 * always present and is the discoverable path, and the same silent-inertness is
 * how `TabKeyboardNav`'s browser-reserved chords already behave.
 */

import { isTextEntryTarget } from "./keyboard";

/** Rendered shortcut hint (the teach-the-shortcut pattern). */
export const RAIL_COLLAPSE_HINT = "⌘B";

// localStorage key name, not a credential — gitleaks generic-api-key
// false-positives on the `*KEY = "<string>"` shape (mirrors lib/tabs.tsx).
const STORAGE_KEY = "cockpit.rail.collapsed.v1"; // gitleaks:allow

/**
 * The toggle's accessible name for a given state. Names the RESULT of pressing
 * it, not the current state — "Collapse sidebar" while expanded — which is what
 * a button label is for; `aria-expanded` carries the state.
 */
export function railToggleLabel(collapsed: boolean): string {
  return collapsed ? "Expand sidebar" : "Collapse sidebar";
}

/**
 * True when the keyboard event is the collapse chord AND focus is not in a
 * text-entry surface. Callers still own `preventDefault()` — this function only
 * decides.
 */
export function matchesRailCollapseShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.shiftKey || e.ctrlKey || e.altKey) return false;
  // Compare case-insensitively rather than relying on the shift-adjusted value;
  // Shift is already excluded above, but a caps-locked layout still reports "B".
  if (e.key.toLowerCase() !== "b") return false;
  return !isTextEntryTarget(e.target);
}

/**
 * The subset of `Storage` these helpers touch. Taking it as an optional
 * parameter is what makes the failure path testable without patching the global
 * — a throwing fake is passed in, rather than `localStorage` being monkeyed with
 * and restored. The resolution stays INSIDE the try so an environment with no
 * `localStorage` binding at all is caught too: a default parameter would
 * evaluate the identifier outside it and throw a bare ReferenceError.
 */
export interface RailCollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The persisted collapse state, or `false` (expanded) when nothing is stored or
 * storage is unreadable.
 *
 * Only the literal `"true"` collapses. A private-browsing `localStorage` that
 * throws, or a value written by some other version of this key, degrades to the
 * expanded default — the state that is never wrong, since every destination is
 * visible in it. Same degradation posture as `lib/project-context.tsx` and
 * `lib/tabs.tsx`: a storage failure makes the preference session-ephemeral, it
 * never breaks the shell.
 */
export function loadPersistedRailCollapsed(storage?: RailCollapseStorage): boolean {
  try {
    const store = storage ?? localStorage;
    return store.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the collapse state. Storage failures are non-fatal (see above). */
export function persistRailCollapsed(collapsed: boolean, storage?: RailCollapseStorage): void {
  try {
    const store = storage ?? localStorage;
    if (collapsed) {
      store.setItem(STORAGE_KEY, "true");
    } else {
      // Absence IS the expanded default, so clearing the key keeps exactly one
      // representation of "expanded" rather than two ("false" and missing).
      store.removeItem(STORAGE_KEY);
    }
  } catch {
    /* intentional-swallow: the preference degrades to session-ephemeral */
  }
}
