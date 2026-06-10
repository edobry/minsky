/**
 * Entity-tab model for the cockpit workspace (mt#2398).
 *
 * IDE model (principal-confirmed 2026-06-10): rail/browse LIST pages navigate
 * the main pane and do NOT create tabs; only ENTITY DETAILS (a task, a
 * session — later a PR, an ask, a memory) open as tabs. The tab bar is the
 * operator's working set of held-open entities, like editor tabs over a file
 * explorer — not a browser-style everything-is-a-tab strip.
 *
 * Tabs are URL-DRIVEN: a tab is identified by its route path. Navigating to an
 * entity route (deep link, palette jump, row click) opens its tab on visit;
 * clicking a tab navigates to its path; the active tab is derived from the
 * current location. This keeps every consumer (CommandPalette, rail, plain
 * <Link>s) tab-aware for free — they just navigate.
 *
 * Persistence: localStorage. The cockpit daemon is per-workspace already (one
 * daemon + port per workspace key), so a plain storage key IS per-workspace in
 * effect; no key-scoping needed until cockpits multiplex workspaces.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

export type EntityTabKind = "task" | "session";

export interface EntityTab {
  kind: EntityTabKind;
  /** Canonical entity id — e.g. "mt#2370" or a session UUID. */
  entityId: string;
  /** Route path the tab navigates to (path-encoded). */
  path: string;
  /** Short display label — e.g. "mt#2370" or the session id's first 8 chars. */
  label: string;
}

// localStorage key name, not a credential — gitleaks generic-api-key
// false-positives on the `*KEY = "<string>"` shape.
const STORAGE_KEY = "cockpit.tabs.v1"; // gitleaks:allow

/**
 * Match a location pathname against the entity-route registry. Returns the
 * tab descriptor for entity routes, null for list/page routes.
 *
 * Registry (PR1): tasks (`/tasks/:id`, excluding the literal `graph` sibling)
 * and sessions (`/session/:id`). PR/ask/memory kinds join as their detail
 * routes land (mt#2398 PR2 + later).
 */
export function matchEntityRoute(pathname: string): EntityTab | null {
  const session = pathname.match(/^\/session\/([^/]+)$/);
  if (session?.[1]) {
    const id = decodeURIComponent(session[1]);
    return {
      kind: "session",
      entityId: id,
      path: pathname,
      label: id.length > 8 ? `${id.slice(0, 8)}…` : id,
    };
  }

  const task = pathname.match(/^\/tasks\/([^/]+)$/);
  if (task?.[1] && task[1] !== "graph") {
    const id = decodeURIComponent(task[1]);
    return { kind: "task", entityId: id, path: pathname, label: id };
  }

  return null;
}

interface TabsContextValue {
  tabs: EntityTab[];
  /** Path of the active tab, or null when the current route is not an entity route. */
  activePath: string | null;
  closeTab: (path: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function loadTabs(): EntityTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is EntityTab =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as EntityTab).path === "string" &&
        typeof (t as EntityTab).label === "string" &&
        ((t as EntityTab).kind === "task" || (t as EntityTab).kind === "session")
    );
  } catch {
    return [];
  }
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<EntityTab[]>(loadTabs);

  // Persist on every change; storage failures are non-fatal (tabs become
  // session-ephemeral, which is acceptable degradation).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      /* ignore */
    }
  }, [tabs]);

  // Open-on-visit: navigating to an entity route ensures its tab exists.
  useEffect(() => {
    const match = matchEntityRoute(pathname);
    if (!match) return;
    setTabs((prev) => (prev.some((t) => t.path === match.path) ? prev : [...prev, match]));
  }, [pathname]);

  const activePath = useMemo(() => {
    const match = matchEntityRoute(pathname);
    return match ? match.path : null;
  }, [pathname]);

  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const remaining = prev.filter((t) => t.path !== path);
        // Closing the tab you're on: move focus to the last remaining tab,
        // or the default landing when the working set is empty.
        if (path === pathname) {
          const next = remaining[remaining.length - 1];
          navigate(next ? next.path : "/");
        }
        return remaining;
      });
    },
    [navigate, pathname]
  );

  const value = useMemo(() => ({ tabs, activePath, closeTab }), [tabs, activePath, closeTab]);

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error("useTabs must be used within a TabsProvider");
  }
  return ctx;
}