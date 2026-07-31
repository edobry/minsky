/**
 * New-conversation affordance — the single definition the rail control, the
 * ⌘K palette action, and the global shortcut all read (mt#3464).
 *
 * Centralized so the three surfaces cannot drift: a label change, a chord
 * change, or a focus-guard change lands in all of them at once. Before this
 * module the operation existed on exactly one surface (the `/agents` page
 * header) under a label that named its implementation semantics rather than
 * the operator's intent.
 *
 * Naming: "conversation" is the ADR-022 sense — a harness chat. An untasked
 * driven session spawns a claude process in the daemon's repo directory and
 * creates no Minsky workspace clone, so it is a conversation, not a
 * workspace; bare "session" is reserved for the MCP-transport sense.
 *
 * Chord choice (⌘⇧O, meta only) — verified 2026-07-31 against Google's
 * Chrome keyboard-shortcuts documentation:
 *   - ⌘⇧N / Ctrl+Shift+N is Chrome's new-incognito-window binding. A page
 *     cannot intercept it, so it is unusable regardless of how it reads.
 *   - Ctrl+Shift+O is Chrome's Bookmarks Manager on Windows/Linux — but the
 *     Mac binding for that command is ⌘⌥B, which leaves ⌘⇧O free on macOS,
 *     the platform the tray ships for. It is also the chord ChatGPT uses for
 *     a new chat, so it carries transfer.
 *   - `ctrlKey` is deliberately NOT matched: binding it would fight the
 *     Bookmarks Manager on exactly the platforms where that chord is taken.
 *     A Windows/Linux binding, if one is ever wanted, needs a different chord
 *     (Ctrl+Alt+N) rather than a second meaning for a reserved one.
 */

import { isTextEntryTarget } from "./keyboard";

/** Operator-facing label. Used verbatim on every surface. */
export const NEW_CONVERSATION_LABEL = "New conversation";

/** Rendered shortcut hint (the teach-the-shortcut pattern). */
export const NEW_CONVERSATION_HINT = "⌘⇧O";

/**
 * The launch semantics, kept out of the visible label. Surfaces put this in a
 * `title`/`aria-label` so the operator can discover what is actually spawned
 * without the label having to carry it.
 */
export const NEW_CONVERSATION_DESCRIPTION =
  "Start an agent conversation in the daemon's repo directory, bound to no task";

/**
 * Re-exported so this module stays the single import surface for the
 * new-conversation affordance, while the guard itself lives in `./keyboard`
 * (mt#3469) — mt#3464 and mt#3469 each shipped an identical private copy
 * because neither could create a shared file while the other was in flight,
 * and the second to merge owed the merge. Behavior is unchanged.
 */
export { isTextEntryTarget };

/**
 * True when the keyboard event is the new-conversation chord AND focus is not
 * in a text-entry surface. Callers still own `preventDefault()` — this
 * function only decides.
 */
export function matchesNewConversationShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey || !e.shiftKey || e.ctrlKey || e.altKey) return false;
  // `e.key` for this chord is "O" on macOS; compare case-insensitively rather
  // than relying on the shift-adjusted value.
  if (e.key.toLowerCase() !== "o") return false;
  return !isTextEntryTarget(e.target);
}
