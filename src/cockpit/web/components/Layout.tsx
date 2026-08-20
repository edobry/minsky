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
 * available from every route, as is TabKeyboardNav (mt#3469), which needs to
 * sit INSIDE TabsProvider to reach `useTabs` — it renders nothing and exists
 * only to own the tab-switching key bindings. TabCloseBridge (mt#4059) sits
 * there for the same reason and renders nothing either; it owns the
 * `window.__minskyCloseActiveTab` global the tray's ⌘W menu item evals.
 * Children render inside <main> as-is; individual pages control their own
 * internal layout (Layout-flexibility mandate, mt#2370).
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
import { TabKeyboardNav } from "./TabKeyboardNav";
import { PeekHost } from "./PeekHost";
import { TabCloseBridge } from "./TabCloseBridge";
import { TabsProvider } from "../lib/tabs";
import { NewConversationProvider } from "../hooks/useNewConversation";

interface Props {
  children: ReactNode;
}

export function Layout({ children }: Props) {
  return (
    <TabsProvider>
      {/* NewConversationProvider wraps the shell (mt#3464) so the rail
          control, the ⌘K palette action, and the global shortcut share ONE
          launch mutation and ONE keydown registration — see the provider's
          doc comment for the double-fire and silent-failure modes that
          per-surface instances would ship. */}
      <NewConversationProvider>
        <div className="flex h-screen flex-col overflow-hidden bg-background md:flex-row">
          <Rail />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TabBar />
            {/* `scrollbar-readout` (mt#4355): the app's primary content
                scroller is long enough that the bar reads as a position
                indicator, so it opts in to the always-visible token-built
                treatment. Incidental scrollers inside it — code blocks, table
                wrappers, small panes — deliberately do not, and fall back to
                the platform's own bar, which `color-scheme: dark` now renders
                dark. See `index.css` §Scrollbars. */}
            <main className="flex-1 overflow-auto min-w-0 scrollbar-readout">{children}</main>
          </div>
          <CommandPalette />
          <TabKeyboardNav />
          <TabCloseBridge />
          {/* PeekHost (mt#3694) renders the entity side peek over this shell.
              It sits here, a sibling of <main> rather than inside it, so the
              underlying page keeps its scroll position and its mounted state
              while a pane is open — the peek's whole point. It renders null
              when no pane is open, so every un-peeked route pays nothing.

              Independent of TabCloseBridge (mt#4059) above, which landed while
              this was in flight: that installs the ⌘W close-active-TAB seam, and
              a peek deliberately opens no tab, so the two never contend for the
              same state. Both are null-rendering/overlay siblings here. */}
          <PeekHost />
        </div>
      </NewConversationProvider>
    </TabsProvider>
  );
}
