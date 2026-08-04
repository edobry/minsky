/**
 * Scroll-geometry helpers for the conversation thread (mt#3376, mt#3688).
 *
 * The module name records where it started — pinning the live tail — and is kept
 * because every consumer imports from this path; mt#3688 widened it to the
 * thread's other scroll-geometry questions (are we near the top? how far through
 * are we?), which are the same kind of pure, DOM-in/answer-out decision and want
 * the same test harness.
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

/** Values of `overflow-y` that make an element a scroll container. */
const SCROLLING_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

/**
 * Whether `style` describes an element that scrolls its own overflow.
 *
 * Reads the LONGHAND `overflowY`, because that is what a scrollport is defined
 * by vertically, and because computed style resolves the `overflow` shorthand
 * into its longhands — so `overflow: scroll` already surfaces here as
 * `overflowY: "scroll"`.
 *
 * The shorthand is still checked as a fallback for environments whose CSSOM
 * does not perform that resolution (some test DOMs). It covers `auto` AND
 * `scroll`: the original only checked `overflow === "auto"`, which meant a
 * container declared `overflow: scroll` could go undetected in exactly those
 * environments while its `auto` sibling was found (PR #2459 R1).
 */
function scrollsOverflow(style: CSSStyleDeclaration): boolean {
  return SCROLLING_OVERFLOW.has(style.overflowY) || SCROLLING_OVERFLOW.has(style.overflow);
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

/**
 * True when `scrollport` is within one viewport-height of its TOP (mt#3688).
 *
 * The trigger for revealing older turns as the operator scrolls back through a
 * conversation. The threshold is the scrollport's OWN `clientHeight` rather than
 * a fixed pixel count, for the reason a prefetch uses a screenful of runway: the
 * reveal has to land before the reader arrives at the boundary, and how much
 * warning that takes is a function of how much they can see at once, not of a
 * number chosen in the abstract. A 4K display gets proportionally more runway
 * than a laptop half-window, automatically.
 *
 * A scrollport with nothing to scroll is NOT near the top — it has no top to be
 * near, and reporting one would fire a reveal for a thread the operator never
 * scrolled. The manual control stays available for that case.
 */
export function isNearTop(scrollport: Element | null, viewportsOfRunway: number = 1): boolean {
  if (!scrollport) return false;
  const { scrollTop, scrollHeight, clientHeight } = scrollport;
  if (scrollHeight <= clientHeight) return false;
  return scrollTop <= clientHeight * viewportsOfRunway;
}

/**
 * Whether a scrollport's content got TALLER between two measurements (mt#3445).
 *
 * The live tail's "something arrived below you" signal cannot be a turn count:
 * a streaming turn folds every delta into ONE block, so the count holds still
 * for the whole message while hundreds of pixels of content appear below the
 * reader. Measured height moves in both cases, which is why it is the signal.
 *
 * Two cases are deliberately NOT growth:
 *   - `previous === null` — the first measurement is a baseline. There is no
 *     earlier height to have grown from, and reporting one would surface the
 *     affordance on mount.
 *   - `current <= previous` — the thread got shorter or stayed put. A window
 *     resize that reflows the thread narrower makes it TALLER and one that
 *     makes it wider makes it SHORTER; only the first direction can mean
 *     content is hiding below.
 */
export function hasGrown(previousHeight: number | null, currentHeight: number): boolean {
  if (previousHeight === null) return false;
  return currentHeight > previousHeight;
}

/**
 * How far through its scrollable range a scrollport sits, as `0..1` (mt#3688).
 *
 * A scrollport with nothing to scroll answers `1`, not `0`: the operator can see
 * the whole thread at once, and the thread's own convention is that the resting
 * position is the newest turn (the mount scrolls there). Answering `0` would
 * render a short conversation as "you are at the beginning" when the reader is
 * equally at the end.
 */
export function scrollFraction(scrollport: Element | null): number {
  if (!scrollport) return 1;
  const { scrollTop, scrollHeight, clientHeight } = scrollport;
  const range = scrollHeight - clientHeight;
  if (range <= 0) return 1;
  return Math.min(1, Math.max(0, scrollTop / range));
}

/**
 * Which turn of the WHOLE transcript the viewport is looking at (mt#3688).
 *
 * `hiddenBefore` turns are not rendered at all, so they occupy zero scroll
 * height: the scrollport's range covers only the rendered tail, and the answer
 * is that range's fraction mapped onto the rendered turns, offset past the
 * hidden ones. That makes the two ends exact — top of the rendered content IS
 * turn `hiddenBefore`, bottom IS `total` — and the middle an estimate, because
 * turns are wildly different heights (a one-line prompt and an expanded tool
 * block are the same one turn). Callers render it with a `~` for that reason;
 * an operator asking "where am I" is asking within a few percent, not within a
 * turn.
 */
export function threadPositionFromScroll(
  fraction: number,
  hiddenBefore: number,
  totalTurns: number
): number {
  if (totalTurns <= 0) return 0;
  const rendered = Math.max(0, totalTurns - hiddenBefore);
  const within = Math.round(Math.min(1, Math.max(0, fraction)) * rendered);
  return Math.min(totalTurns, hiddenBefore + within);
}

/** The thread's position readout — `~340 / 512`. */
export function formatThreadPosition(position: number, totalTurns: number): string {
  return `~${position} / ${totalTurns}`;
}
