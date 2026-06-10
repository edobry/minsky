/**
 * TabBar — the workspace's working-set strip (mt#2398).
 *
 * Renders the open entity tabs (IDE model: entities only, never list pages).
 * Hidden entirely while the working set is empty so the default landing stays
 * clean. Overflow: horizontal scroll (craft decision recorded in the spec).
 *
 * Semantics: these are URL-driven LINKS, not ARIA tabs — each "tab" navigates
 * to its entity route, so the honest pattern is a <nav> of links with
 * `aria-current` on the active one. We deliberately do NOT use
 * role="tablist"/"tab": those roles promise a roving-tabindex + arrow-key
 * keyboard contract that link navigation doesn't have (reviewer R1 finding).
 * Links and the close buttons are natively focusable and keyboard-operable.
 */
import { Link } from "react-router-dom";
import { X, Network, Bot, GitBranch } from "lucide-react";
import { useTabs, type EntityTabKind } from "../lib/tabs";
import { cn } from "../lib/utils";

const KIND_ICONS: Record<EntityTabKind, React.ComponentType<{ className?: string }>> = {
  task: Network,
  session: Bot,
  agent: GitBranch,
};

// Defensive default: tabs are PERSISTED (localStorage), so a kind written by a
// newer/older build than the one rendering it must degrade to a generic icon —
// an undefined component here crashes the whole shell (React #130; TabBar sits
// outside the page ErrorBoundaries). Originating incident: mt#2440 — mt#1919
// shipped the "agent" kind without this map entry and /agents/:id blanked the
// cockpit on every load until the entry landed.
const FALLBACK_ICON: React.ComponentType<{ className?: string }> = Bot;

export function TabBar() {
  const { tabs, activePath, closeTab } = useTabs();

  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label="Open entities"
      className="flex h-9 flex-shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border bg-background px-1"
    >
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const Icon = KIND_ICONS[tab.kind] ?? FALLBACK_ICON;
        return (
          <div
            key={tab.path}
            className={cn(
              "group flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 text-sm transition-colors",
              active
                ? "border-primary bg-muted/60 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            )}
          >
            <Link
              to={tab.path}
              className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
              aria-current={active ? "page" : undefined}
              title={tab.entityId}
            >
              <Icon aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="max-w-[160px] truncate font-mono text-xs">{tab.label}</span>
            </Link>
            <button
              type="button"
              aria-label={`Close ${tab.entityId}`}
              onClick={() => closeTab(tab.path)}
              className={cn(
                "rounded p-0.5 transition-opacity hover:bg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70"
              )}
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </nav>
  );
}
