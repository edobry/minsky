/**
 * Shared primitives for the cockpit's global keyboard shortcuts.
 *
 * The cockpit grew its first two non-⌘K shortcuts in parallel — mt#3464's
 * new-conversation chord and mt#3469's tab navigation — and each landed with
 * its own copy of the focus guard, because neither could safely create a shared
 * file while the other was in flight. Both PRs recorded the same rule: whichever
 * merged second unifies them. This module is that unification; there is now one
 * definition, and a new shortcut should import it rather than write a third.
 */

/**
 * True when the event target is a text-entry surface, where a shortcut must
 * yield to typing.
 *
 * Covers `INPUT`, `TEXTAREA`, `SELECT`, and any contenteditable host —
 * `isContentEditable` is inherited, so a node nested inside a rich-text region
 * reports true as well. `SELECT` is included because typeahead there selects a
 * matching option, so a swallowed keystroke silently changes a value.
 *
 * Worth keeping even for chords carrying two modifiers, which a literal
 * keystroke cannot collide with: it stops a shortcut firing out from under
 * someone mid-compose, and it is what makes a chord swappable — a future
 * bare-key binding (Linear's `C`) needs exactly this check and would be unsafe
 * to adopt without it.
 *
 * Deliberately NOT covered: `role="textbox"` and `aria-multiline` hosts that
 * are not natively contenteditable. No cockpit surface renders one today; if
 * one appears, widen it here, once, rather than at a call site.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
