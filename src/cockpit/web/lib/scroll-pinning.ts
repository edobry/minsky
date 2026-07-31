/**
 * Scroll-pinning helpers for the live conversation tail (mt#3376).
 *
 * The conversation view scrolled to the newest turn on EVERY live append, with
 * no check for where the operator actually was. Reading back through an active
 * session, each new tool call or message yanked the view to the bottom
 * mid-sentence.
 *
 * Pure DOM helpers, no React — so the pinned/not-pinned decision is testable
 * without rendering a thread.
 *
 * @see mt#3376 — this module
 * @see ../widgets/ConversationView.tsx — the consumer
 */

/**
 * Slack, in px, within which the scrollport counts as "at the bottom".
 *
 * Derived from a constant this codebase already commits to rather than picked
 * round: the thread's end sentinel carries `scroll-mb-8` (2rem = 32px), so
 * `scrollIntoView({block:"end"})` deliberately parks it 32px above the
 * scrollport's bottom edge (mt#3344). A reader the view just scrolled for is
 * therefore already up to 32px off the true bottom — a threshold at or below
 * that would make the view consider itself unpinned immediately after its own
 * scroll. 32px (the designed offset) + 16px (sub-pixel rounding, fractional
 * devicePixelRatio) = 48.
 */
export const PINNED_THRESHOLD_PX = 48;

/** Elements that can scroll their overflow. */
function scrollsOverflow(style: CSSStyleDeclaration): boolean {
  return style.overflowY === "auto" || style.overflowY === "scroll" || style.overflow === "auto";
}

/**
 * The element that actually scrolls `el` into view — the nearest ancestor with
 * scrollable overflow, else the document's scrolling element.
 *
 * Resolved rather than assumed because it genuinely differs per host:
 * `DrivenSessionPage` wraps the thread in an `overflow-y-auto` div, while the
 * workspace/conversation tabs scroll further up the tree. Hard-coding either
 * would fix one surface and silently miss the other.
 */
export function findScrollParent(el: Element | null): Element | null {
  let node: Element | null = el?.parentElement ?? null;
  while (node) {
    // `getComputedStyle` is unavailable in a non-DOM context; callers only run
    // this from effects, but guard so a stray call can't throw.
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    if (style && scrollsOverflow(style) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return typeof document !== "undefined" ? document.scrollingElement : null;
}

/**
 * True when `scrollport` is scrolled to (or within {@link PINNED_THRESHOLD_PX}
 * of) its bottom.
 *
 * A scrollport with nothing to scroll (`scrollHeight <= clientHeight`) is
 * pinned by definition — there is no "up" for the operator to have scrolled to,
 * so a short thread must keep its existing follow-the-tail behavior.
 */
export function isPinnedToBottom(
  scrollport: Element | null,
  threshold: number = PINNED_THRESHOLD_PX
): boolean {
  if (!scrollport) return true;
  const { scrollTop, scrollHeight, clientHeight } = scrollport;
  if (scrollHeight <= clientHeight) return true;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
