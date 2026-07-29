/**
 * Layout — shell wrapper for the Cockpit app (mt#2397 rail, mt#2398 tabs).
 *
 * Two-column app shell on desktop, single column on mobile (mt#2604):
 *   1. Rail — persistent left navigation spine on `md`+ (mt#2397); below
 *      `md` it renders a slim top bar + hamburger-triggered slide-in drawer
 *      instead (mt#2604), so the outer container's flex-direction switches
 *      from column (mobile: top bar stacked above content) to row (desktop:
 *      sidebar beside content) at the same `md` breakpoint Rail uses.
 *   2. Workspace column — TabBar (the open-entity working set, hidden when
 *      empty) above the scrollable main content area.
 *
 * TabsProvider lives here so the tab model is URL-driven app-wide: any
 * navigation to an entity route (rail, palette, row click, deep link) opens
 * its tab on visit. The global CommandPalette (⌘K) is mounted here so it is
 * available from every route. Children render inside <main> as-is; individual
 * pages control their own internal layout (Layout-flexibility mandate,
 * mt#2370).
 *
 * `min-h-0` on the workspace column is load-bearing, not decorative (mt#3335).
 * Below `md` the root is `flex-col`, which makes that column a COLUMN-flex
 * item — so its automatic minimum size is its own content height and it cannot
 * shrink. Without `min-h-0`, <main> is handed full content height instead of
 * the leftover space, never becomes a scroller, and the root's
 * `overflow-hidden` clips everything below the fold with no way to reach it:
 * narrow windows could not scroll AT ALL. (Above `md` the same div is a
 * ROW-flex item stretched to the container height, and <main> — being a scroll
 * container, so its own auto minimum size is already 0 — shrinks correctly,
 * which is why the bug was invisible at normal widths.) Canonical fix per
 * flexbugs #241; note Firefox wants `min-height: 0` on ancestors too, so keep
 * it if this tree gains another intermediate flex layer.
 */
import { type ReactNode } from "react";
import { Rail } from "./Rail";
import { TabBar } from "./TabBar";
import { CommandPalette } from "./CommandPalette";
import { TabsProvider } from "../lib/tabs";

interface Props {
  children: ReactNode;
}

export function Layout({ children }: Props) {
  return (
    <TabsProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background md:flex-row">
        <Rail />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabBar />
          <main className="flex-1 overflow-auto min-w-0">{children}</main>
        </div>
        <CommandPalette />
      </div>
    </TabsProvider>
  );
}
