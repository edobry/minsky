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
import { X, Network, Bot, GitBranch, CircleHelp, Brain } from "lucide-react";
import { useTabs, type EntityTabKind } from "../lib/tabs";
import { cn } from "../lib/utils";

const KIND_ICONS: Record<EntityTabKind, React.ComponentType<{ className?: string }>> = {
  task: Network,
  session: Bot,
  agent: GitBranch,
  ask: CircleHelp,
  memory: Brain,
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

export function TabBar() {
  const { tabs, activePath, closeTab } = useTabs();

  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label="Open entities"
      className="flex h-9 flex-shrink-0 items-stretch gap-0.5 overflow-x-auto scrollbar-none border-b border-border bg-background px-1"
    >
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const Icon = resolveKindIcon(tab.kind);
        return (
          <div
            key={tab.path}
            className={cn(
              "group flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 text-sm transition-colors",
              active
                ? "border-primary bg-muted font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            )}
          >
            <Link
              to={tab.path}
              className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
              aria-current={active ? "location" : undefined}
              title={tab.entityId}
            >
              <Icon
                aria-hidden
                className={cn("h-3.5 w-3.5 flex-shrink-0", active && "text-primary")}
              />
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