/**
 * TabBar — the workspace's working-set strip (mt#2398).
 *
 * Renders the open entity tabs (IDE model: entities only, never list pages).
 * Hidden entirely while the working set is empty so the default landing stays
 * clean. Overflow: horizontal scroll (craft decision recorded in the spec). The
 * scroll container hides its scrollbar chrome via `.scrollbar-none` and pins
 * overflow-y hidden, so no scrollbar (horizontal or vertical) renders inside
 * the fixed h-9 strip at any zoom level — with overflow-x auto, the y-axis
 * would otherwise compute to auto and flash a vertical bar at extreme
 * zoom/DPI.
 *
 * Because that scrollbar is suppressed, scroll ALONE left overflow invisible:
 * measured at 49 open tabs, 9 fit and 40 sat off-screen with no indicator, no
 * count, and no way to reach them — and an active tab among them could not be
 * seen at all. mt#3252 adds the two affordances that make a scrolling strip
 * honest: the active tab scrolls itself into view, and a trailing control
 * reports the hidden count while listing every open tab (plus bulk close).
 * The set is bounded by `MAX_OPEN_TABS`; see `lib/tabs.tsx`.
 *
 * Semantics: these are URL-driven LINKS, not ARIA tabs — each "tab" navigates
 * to its entity route, so the honest pattern is a <nav> of links with
 * `aria-current` on the active one. We deliberately do NOT use
 * role="tablist"/"tab": those roles promise a roving-tabindex + arrow-key
 * keyboard contract that link navigation doesn't have (reviewer R1 finding).
 * Links and the close buttons are natively focusable and keyboard-operable.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  X,
  Network,
  Bot,
  GitBranch,
  CircleHelp,
  Brain,
  GitPullRequest,
  AlertCircle,
  ChevronsRight,
  MessageSquare,
  Filter,
} from "lucide-react";
import { useTabs, type EntityTab, type EntityTabKind } from "../lib/tabs";
import { useEntityLabel } from "../lib/entity-labels";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "../lib/utils";

const KIND_ICONS: Record<EntityTabKind, React.ComponentType<{ className?: string }>> = {
  task: Network,
  session: Bot,
  agent: GitBranch,
  ask: CircleHelp,
  memory: Brain,
  changeset: GitPullRequest,
  // mt#3400 — the drive view is where the operator TYPES to the agent, so it
  // reads as a conversation rather than as another `Bot` (the passive
  // observed-conversation kind). Retires with the kind itself; see
  // `lib/tabs.tsx`'s `EntityTabKind` docblock.
  driven: MessageSquare,
  // mt#4010 — deliberately NOT a shield. Only ~46% of the corpus computes into
  // the `guard` family; detectors and injectors intervene without blocking
  // anything, and the three families are computed and non-exclusive (ontology
  // §4). A neutral "something sits in this path" icon is the honest one.
  interceptor: Filter,
};

const FALLBACK_ICON: React.ComponentType<{ className?: string }> = Bot;

/**
 * Resolve a tab kind to its icon, degrading to a generic icon for any kind
 * missing from KIND_ICONS. `loadTabs()` filters kinds it doesn't recognize,
 * so the realistic gap this guards is a kind ACCEPTED by the loader but
 * missing from this map — exactly how mt#2440 happened: mt#1919 added
 * "agent" to the loader's accept-list without a map entry, the undefined
 * component threw React #130, and (TabBar rendering outside the page
 * ErrorBoundaries) the whole shell blanked on every load while the tab was
 * persisted in localStorage.
 */
export function resolveKindIcon(kind: EntityTabKind): React.ComponentType<{ className?: string }> {
  return KIND_ICONS[kind] ?? FALLBACK_ICON;
}

/** The horizontal extent of a rect — all `countHiddenTabs` needs. */
export interface HorizontalExtent {
  left: number;
  right: number;
}

/**
 * How many of `tabs` fall outside `strip`'s visible extent (mt#3252).
 *
 * ## The bound is the strip's border-box rect, deliberately — do NOT subtract padding
 *
 * `overflow-x: auto` clips at the **padding box**, not the content box: padding
 * is inside the scrollport, so a tab scrolled into the strip's `px-1` zone is
 * still painted and still clickable. The strip has no border, so its
 * `getBoundingClientRect()` IS its padding box — the exact clip region.
 * Subtracting `paddingLeft`/`paddingRight` would narrow the bound below the real
 * clip and report a visible tab as hidden.
 *
 * Measured on the running cockpit (12 tabs, 600px strip, 1548px of content) at
 * four scroll offsets — start, end, mid, and a fractional `scrollLeft` — the
 * padding-subtracting variant returns an identical count at every one, because
 * a tab edge never lands strictly inside the 4px padding band. So the change
 * would be a no-op here and wrong in the general case. (PR #2339 R1 asked for
 * it; this is the refutation.)
 *
 * ## A partially clipped tab counts as HIDDEN, by design
 *
 * The count answers "how many tabs can I not read from here". Clipping truncates
 * the label, and a tab showing three pixels of its title is not identifiable —
 * so any clipped edge counts. This is a definitional choice, not an off-by-one:
 * a midpoint-visibility rule (what a hit-test measures) reports one fewer
 * whenever a tab straddles an edge. Pinned by test.
 *
 * The 1px tolerance absorbs sub-pixel layout rounding, which would otherwise
 * report a flush-fitting tab as clipped.
 *
 * Pure (rects in, count out) so the measurement rule is unit-testable — jsdom
 * reports every rect as zero, so it cannot be exercised through the DOM.
 */
export function countHiddenTabs(strip: HorizontalExtent, tabs: HorizontalExtent[]): number {
  return tabs.filter((tab) => tab.left < strip.left - 1 || tab.right > strip.right + 1).length;
}

/**
 * Derived tab label (mt#2883): resolves the tab's human-legible name via the
 * shared entity-label resolver, degrading to the persisted shortened-id label
 * while data loads. Enriched titles render in the UI sans face; the id
 * fallback keeps its monospace treatment (it IS an identifier). Split out as
 * a child component so the resolver hook runs per tab.
 */
function TabLabel({ tab }: { tab: EntityTab }) {
  const { primary, enriched } = useEntityLabel(tab);
  // Tooltip carries BOTH the full derived label (the visible text truncates)
  // AND the raw entity id — this inner title wins over the parent Link's on
  // hover, so it must not drop the raw-id contract (reviewer R1). In the
  // error case the span sets NO title, letting the parent Link's
  // "<id> (not found)" tooltip stand alone (one title per contract).
  const tooltip = enriched ? `${primary}\n${tab.entityId}` : tab.entityId;
  return (
    <span
      className={cn(
        "max-w-[220px] truncate text-xs",
        enriched ? "font-sans" : "font-mono",
        tab.error && "text-destructive"
      )}
      title={tab.error ? undefined : tooltip}
    >
      {primary}
    </span>
  );
}

/**
 * One tab. Scrolls itself into view when it becomes active (mt#3252) — with 40
 * tabs off-screen, landing on an entity by deep link or palette jump would
 * otherwise leave the active tab invisible. `inline: "nearest"` scrolls the
 * strip the minimum distance; `block: "nearest"` keeps the page from scrolling
 * vertically to chase it.
 */
function TabItem({
  tab,
  active,
  onClose,
}: {
  tab: EntityTab;
  active: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const Icon = resolveKindIcon(tab.kind);

  useEffect(() => {
    if (!active) return;
    // Optional-called: jsdom does not implement scrollIntoView.
    ref.current?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [active]);

  return (
    <div
      ref={ref}
      data-tab-path={tab.path}
      className={cn(
        "group flex flex-shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 text-sm transition-colors",
        active
          ? "border-primary bg-muted font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      )}
    >
      <Link
        to={tab.path}
        className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring rounded-sm"
        aria-current={active ? "location" : undefined}
        title={tab.error ? `${tab.entityId} (not found)` : tab.entityId}
      >
        {/* Error chip (mt#2769): the tab's entity 404'd. Swaps the kind
            icon for an alert glyph — the tab is not persisted across
            reload (see tabs.tsx's persist effect), so this state is
            visible only for the current visit. */}
        {tab.error ? (
          <AlertCircle aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-destructive" />
        ) : (
          <Icon aria-hidden className={cn("h-3.5 w-3.5 flex-shrink-0", active && "text-primary")} />
        )}
        <TabLabel tab={tab} />
      </Link>
      <button
        type="button"
        aria-label={`Close ${tab.entityId}`}
        onClick={onClose}
        className={cn(
          "rounded p-0.5 transition-opacity hover:bg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70"
        )}
      >
        <X aria-hidden className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * Trailing overflow control (mt#3252): the strip's index and its bulk-release
 * gestures.
 *
 * Rendered whenever the strip has tabs, not only while it overflows — it hosts
 * "close all" / "close others", which the strip needs at any length (the only
 * release gesture before this was per-tab, one click at a time). The hidden
 * COUNT is the conditional part, since that is what has nothing to say when
 * everything fits.
 */
function TabOverflowMenu({ hiddenCount }: { hiddenCount: number }) {
  const { tabs, activePath, closeAllTabs, closeOtherTabs } = useTabs();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const label =
    hiddenCount > 0
      ? `Open entities: ${tabs.length} open, ${hiddenCount} out of view`
      : `Open entities: ${tabs.length} open`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // Sighted users get the same sentence on hover: the control is
          // icon-only (plus the conditional +N), so without this its purpose is
          // legible to a screen reader and to nobody else (PR #2339 R1).
          title={label}
          className="flex flex-shrink-0 items-center gap-1 self-center rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronsRight aria-hidden className="h-3.5 w-3.5" />
          {hiddenCount > 0 && <span className="tabular-nums">+{hiddenCount}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1" align="end">
        <div className="max-h-64 overflow-y-auto">
          {tabs.map((tab) => {
            const Icon = resolveKindIcon(tab.kind);
            return (
              <Link
                key={tab.path}
                to={tab.path}
                onClick={close}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  tab.path === activePath ? "text-foreground" : "text-muted-foreground"
                )}
              >
                <Icon aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{tab.label}</span>
              </Link>
            );
          })}
        </div>
        <div className="mt-1 flex items-center gap-1 border-t border-border pt-1">
          <button
            type="button"
            onClick={() => {
              closeAllTabs();
              close();
            }}
            className="flex-1 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            Close all
          </button>
          {activePath && tabs.length > 1 && (
            <button
              type="button"
              onClick={() => {
                closeOtherTabs(activePath);
                close();
              }}
              className="flex-1 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              Close others
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function TabBar() {
  const { tabs, activePath, closeTab } = useTabs();
  const stripRef = useRef<HTMLDivElement>(null);
  const [hiddenCount, setHiddenCount] = useState(0);

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const tabRects = [...strip.querySelectorAll<HTMLElement>("[data-tab-path]")].map((el) =>
      el.getBoundingClientRect()
    );
    setHiddenCount(countHiddenTabs(strip.getBoundingClientRect(), tabRects));
  }, []);

  /**
   * Bring the active tab back into view after a LAYOUT change.
   *
   * `TabItem` already scrolls itself in when it becomes active, but that fires
   * once, on activation — and tab labels resolve asynchronously (mt#2883), so
   * every tab widens shortly after mount. Measured live: the strip scrolled to
   * the active tab, the labels then enriched, and the active tab was pushed back
   * out of view. Re-running on resize closes that window.
   *
   * Deliberately NOT wired to the scroll listener: a scroll may be the operator
   * deliberately looking away from the active tab, and yanking it back would
   * make the strip unusable. `ResizeObserver` never fires on scrolling.
   */
  const scrollActiveIntoView = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || !activePath) return;
    for (const el of strip.querySelectorAll<HTMLElement>("[data-tab-path]")) {
      if (el.getAttribute("data-tab-path") === activePath) {
        el.scrollIntoView?.({ inline: "nearest", block: "nearest" });
        return;
      }
    }
  }, [activePath]);

  // Measure after layout so the first paint carries a correct count, and again
  // whenever the tab set changes.
  useLayoutEffect(() => {
    measure();
  }, [measure, tabs]);

  // Re-measure on the two inputs that change the count without changing the tab
  // set: scrolling the strip, and width changes. Observing each TAB (not just
  // the strip) is what catches async label resolution — the strip's own box is
  // fixed-height and full-width, so it never resizes when its content does.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.addEventListener("scroll", measure, { passive: true });
    // jsdom (bun test) has no ResizeObserver; scroll and tab-set changes still
    // drive measurement there.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            measure();
            scrollActiveIntoView();
          });
    if (observer) {
      observer.observe(strip);
      for (const el of strip.querySelectorAll("[data-tab-path]")) observer.observe(el);
    }
    return () => {
      strip.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [measure, scrollActiveIntoView, tabs]);

  if (tabs.length === 0) return null;

  return (
    <div className="flex h-9 flex-shrink-0 items-stretch border-b border-border bg-background">
      <nav
        ref={stripRef}
        aria-label="Open entities"
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden scrollbar-none px-1"
      >
        {tabs.map((tab) => (
          <TabItem
            key={tab.path}
            tab={tab}
            active={tab.path === activePath}
            onClose={() => closeTab(tab.path)}
          />
        ))}
      </nav>
      <div className="flex flex-shrink-0 items-stretch pr-1">
        <TabOverflowMenu hiddenCount={hiddenCount} />
      </div>
    </div>
  );
}
