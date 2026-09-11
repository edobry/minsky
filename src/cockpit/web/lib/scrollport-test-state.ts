/**
 * Reset the geometry three test files stamp onto `document.scrollingElement` (mt#3575).
 *
 * `ConversationView.windowing.test.tsx`, `ConversationView.scroll-pinning.test.tsx`
 * and `lib/scroll-pinning.test.ts` each give the scrollport real dimensions with
 * `Object.defineProperty`, because happy-dom lays every element out at zero
 * height and the component under test would otherwise never see a scrollable
 * ancestor.
 *
 * `document.scrollingElement` is a PROCESS-GLOBAL, and testing-library's
 * `cleanup` only unmounts components — it does not remove own properties defined
 * on a DOM node. So the stamped `scrollTop` survives into every later test, in
 * this file and in every file that runs after it in the same `bun test` process.
 *
 * That made "a reader who never scrolls still gets the tail-tracking window"
 * pass for the wrong reason: in DECLARATION order its predecessor left
 * `scrollTop` at the bottom (1600), which is the pinned state that test asserts.
 * Under any other order the predecessor left 800 — scrolled up, frozen window —
 * and it failed. Declaration order was the only passing order; measured
 * 2026-09-03, the suite was clean with `randomize = false` and failed under all
 * six seeds tried with it `true`.
 *
 * Call this in a `beforeEach` so each block establishes its own scrollport
 * rather than inheriting one (`docs/testing-patterns.md` failure shape 4).
 * Deleting rather than zeroing is deliberate: it restores the node to its
 * prototype getters, which is the state a fresh document actually has, whereas
 * writing 0 would leave own properties behind that shadow them.
 */
const STAMPED_PROPS = ["scrollHeight", "clientHeight", "scrollTop"] as const;

export function resetScrollportGeometry(): void {
  const port = document.scrollingElement as HTMLElement | null;
  if (!port) return;
  for (const prop of STAMPED_PROPS) {
    // Only own properties are ours to remove; the prototype accessors are not.
    // `Reflect.deleteProperty` rather than `delete` on a cast: the cast this
    // needed (`as unknown as Record<string, unknown>`) is the one the
    // no-excessive-as-unknown rule exists to discourage, and Reflect takes an
    // `object` directly.
    if (Object.getOwnPropertyDescriptor(port, prop) !== undefined) {
      Reflect.deleteProperty(port, prop);
    }
  }
}
