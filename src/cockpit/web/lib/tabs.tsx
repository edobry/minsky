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
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { shortenId } from "./format";

/**
 * `"driven"` (mt#3400) is a TEMPORARY member of this union. mt#3095 re-keys the
 * drive surface from the spawn-time localId this kind addresses to the harness
 * conversation id ("the localId demotes to a session driver implementation detail"),
 * and mt#3130 Phase 6 then deprecates `/driven/:id` outright once the composer
 * lands on the unified conversation route. At that point a driven tab is just a
 * conversation tab and this member is deleted.
 *
 * Escalation threshold: if mt#3095 is still TODO 10 days after this ships,
 * surface a reprioritization prompt rather than silently carrying the extra
 * kind (`work-completion.mdc §Temporary mechanism budget`; the 10-day value is
 * `decision-defaults.mdc §Thresholds`' lynchpin-tracking figure — mt#3095 gates
 * mt#3130 Phase 6).
 *
 * On removal, do NOT reach for `migrateLegacySessionPath` as the model: that is
 * a syntactic path rewrite with the SAME id on both sides, whereas the mt#3095
 * re-key changes the id-space and cannot be resolved by a synchronous
 * load-time function. Keep `/driven/:localId` resolving via a server-side
 * redirect instead, and let any stale tab fall through the existing
 * `markTabError` chip path.
 */
export type EntityTabKind =
  | "task"
  | "session"
  | "agent"
  | "ask"
  | "memory"
  | "changeset"
  | "driven"
  | "interceptor";

export interface EntityTab {
  kind: EntityTabKind;
  /** Canonical entity id — e.g. "mt#2370" or a session UUID. */
  entityId: string;
  /** Route path the tab navigates to (path-encoded). */
  path: string;
  /** Short display label — e.g. "mt#2370" or the session id's first 8 chars. */
  label: string;
  /**
   * Set when the entity this tab addresses failed to resolve (e.g. a 404 on
   * the conversation snapshot fetch) — mt#2769. Render-only flag: EXCLUDED
   * from persistence (see `TabsProvider`'s persist effect) so an errored tab
   * shows an error chip for the current visit but does not resurrect on
   * reload. Never read from localStorage — always undefined on load.
   */
  error?: boolean;
  /**
   * Epoch ms of the tab's last activation — the LRU key (mt#3252). Absent in
   * payloads persisted before this field existed; `loadTabs` back-fills those
   * from persisted (open) order, the only recency proxy available for them.
   */
  lastActiveAt?: number;
}

// localStorage key name, not a credential — gitleaks generic-api-key
// false-positives on the `*KEY = "<string>"` shape.
const STORAGE_KEY = "cockpit.tabs.v1"; // gitleaks:allow

/**
 * Ceiling on the open-tab working set (mt#3252).
 *
 * Grounded in the strip's measured geometry rather than a round number (per
 * `decision-defaults §Thresholds`): at the observed cockpit width (1360px) and
 * median tab width (127px) the strip fits 9 tabs. A cap of 12 keeps the whole
 * working set inside ~1.3 strip-widths — any tab is one short scroll or one
 * overflow-menu open away — while leaving headroom above what fits so the cap
 * does not fight ordinary multi-entity work.
 *
 * Before this cap existed nothing ever removed a tab: the open-on-visit effect
 * appended one per entity route visited and persisted it forever, so merely
 * LOOKING at an entity committed it to the working set. The measured result was
 * 49 tabs, 9 visible, 40 unreachable behind a deliberately-hidden scrollbar.
 * Retiring open-on-visit in favour of preview-tab semantics — the model fix
 * this cap only bounds — is mt#3255.
 */
export const MAX_OPEN_TABS = 12;

/**
 * Trim `tabs` to `cap` by dropping least-recently-active entries.
 *
 * `protectPath` (the active tab) is never a candidate: evicting the tab the
 * operator is looking at would navigate the shell out from under them.
 *
 * The result therefore exceeds `cap` in exactly one situation: `cap < 1`, where
 * the single protected tab is already over budget and wins anyway (a cap is a
 * budget for the working set, not a licence to close what is on screen). At any
 * `cap >= 1` — every production path, since `MAX_OPEN_TABS` is 12 — the returned
 * length is always `<= cap`, because at most one tab is protected and the
 * remaining `length - 1` are all evictable. PR #2339 R1 read the documented
 * over-budget case as a general possibility; it is reachable only from a test
 * passing `cap: 0`, and both facts are pinned by test.
 *
 * Ties break by array position, which is open order. That matters for tabs
 * back-filled by `loadTabs`, whose synthetic recencies are ordinal.
 */
export function evictToCap(
  tabs: EntityTab[],
  opts: { cap?: number; protectPath?: string | null } = {}
): EntityTab[] {
  const cap = opts.cap ?? MAX_OPEN_TABS;
  if (tabs.length <= cap) return tabs;
  const protectPath = opts.protectPath ?? null;
  const evictable = tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => tab.path !== protectPath)
    .sort((a, b) => (a.tab.lastActiveAt ?? 0) - (b.tab.lastActiveAt ?? 0) || a.index - b.index);
  const evicted = new Set(evictable.slice(0, tabs.length - cap).map(({ tab }) => tab.path));
  return tabs.filter((tab) => !evicted.has(tab.path));
}

/** Direction of a relative tab move. */
export type TabCycleDirection = "next" | "prev";

/**
 * Which ordering a relative move walks (mt#3469).
 *
 * `"positional"` is strip order — the iTerm idiom, and the one that reads
 * correctly WHILE a strip is visible, because the operator can see where the
 * move is headed. `"mru"` is recency order — the VS Code ⌃Tab idiom, which
 * needs no strip at all and therefore keeps working if the shell ever retires
 * one (mem#742's proposed rework); only the collection it walks would change.
 * Shipping both is nearly free: `EntityTab.lastActiveAt` already exists as
 * mt#3252's LRU key, so the MRU order is a sort over data already stored.
 */
export type TabCycleMode = "positional" | "mru";

/**
 * Step one position through `orderedPaths`, wrapping at both ends.
 *
 * Returns null when there is nothing to move to — fewer than two entries, per
 * the mt#3469 criterion that every binding is a no-op at zero or one open tab.
 *
 * When `currentPath` is absent from the list the operator is on a non-entity
 * route (a rail/list page, which by design opens no tab), so there is no
 * neighbour to be relative TO. Rather than dying there — a common state,
 * reached by any rail click — the move enters the list at its near end: the
 * first entry going "next", the last going "prev". That is the same thing
 * wrapping does at a boundary, so it needs no separate mental model.
 */
export function stepInOrder(
  orderedPaths: string[],
  currentPath: string | null,
  direction: TabCycleDirection
): string | null {
  const n = orderedPaths.length;
  if (n < 2) return null;
  const index = currentPath === null ? -1 : orderedPaths.indexOf(currentPath);
  if (index < 0) return (direction === "next" ? orderedPaths[0] : orderedPaths[n - 1]) ?? null;
  const delta = direction === "next" ? 1 : -1;
  return orderedPaths[(index + delta + n) % n] ?? null;
}

/**
 * Tab paths in most-recently-active order, active tab first (mt#3469).
 *
 * The active tab is placed at index 0 EXPLICITLY rather than trusted to sort
 * there on its own `lastActiveAt`. Two tabs activated inside the same
 * millisecond tie on `Date.now()`, and a tab restored from localStorage may
 * carry `backfillTabRecency`'s synthetic ordinal instead of a real timestamp —
 * so recency alone does not reliably put "where the operator is" at the head of
 * the cycle. Anchoring on `activePath` makes index 0 deterministic in both
 * cases. Remaining tabs sort by recency descending, ties broken by open order.
 */
export function mruOrderedPaths(tabs: EntityTab[], activePath: string | null): string[] {
  const rest = tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => tab.path !== activePath)
    .sort((a, b) => (b.tab.lastActiveAt ?? 0) - (a.tab.lastActiveAt ?? 0) || a.index - b.index)
    .map(({ tab }) => tab.path);
  const active = tabs.find((tab) => tab.path === activePath);
  return active ? [active.path, ...rest] : rest;
}

/**
 * Match a location pathname against the entity-route registry. Returns the
 * tab descriptor for entity routes, null for list/page routes.
 *
 * Registry (PR1): tasks (`/tasks/:id`, excluding the literal `graph` sibling)
 * and conversations (`/conversation/:id`, path renamed from `/session/:id`
 * per ADR-022 stage 1, mt#2686 — the tab `kind` stays "session" for now,
 * unrenamed pending a broader tab-kind sweep out of this task's bounded
 * scope). PR/ask/memory kinds join as their detail routes land (mt#2398 PR2
 * + later). Workspace sessions (`/agents/:id`, kind "agent") joined via
 * mt#1919 — distinct id-space from "session" (harness agentSessionId vs
 * Minsky workspace sessionId). Asks (`/ask/:id`) and memories (`/memory/:id`)
 * joined via mt#2410 (mt#2398's PR2).
 *
 * Tab sub-routes (mt#2768): `/agents/:id` and `/conversation/:id` each carry
 * two optional internal-tab suffixes (`/conversation`|`/context` for agents;
 * `/overview`|`/context` for conversations — see `widgets/RunDetail.tsx`).
 * The regexes below accept ONLY those literal suffixes and always normalize
 * `path` to the BASE entity route (no suffix) — the tab strip holds ONE tab
 * per entity regardless of which internal RunDetail tab is active; switching
 * RunDetail tabs must never open a second tab-strip entry for the same run.
 * An unrecognized suffix (e.g. `/agents/abc/def`) does NOT match — no route
 * currently exists for a suffix outside the accepted set, so this preserves
 * the "nested paths under an entity do not match" contract tests rely on.
 */
export function matchEntityRoute(pathname: string): EntityTab | null {
  const session = pathname.match(/^\/conversation\/([^/]+)(?:\/(?:overview|context))?$/);
  if (session?.[1]) {
    const id = decodeURIComponent(session[1]);
    return {
      kind: "session",
      entityId: id,
      path: `/conversation/${session[1]}`,
      label: shortenId(id),
    };
  }

  // mt#3400 — the drive view is the one surface the operator actively WORKS in,
  // and it was the only entity route with no tab: launching a driven session
  // and navigating away left it unreachable from the strip, so recovery meant
  // routing back through the task. Note this does not fight mt#3255's
  // preview-tab plan — that objects to drive-by VISITS pinning tabs, whereas an
  // operator-initiated live drive is the paradigm case for a held-open tab. If
  // mt#3255 introduces preview-vs-pinned semantics, this belongs on the PINNED
  // side.
  const driven = pathname.match(/^\/driven\/([^/]+)$/);
  if (driven?.[1]) {
    const id = decodeURIComponent(driven[1]);
    return {
      kind: "driven",
      entityId: id,
      path: `/driven/${driven[1]}`,
      label: shortenId(id),
    };
  }

  const agent = pathname.match(/^\/agents\/([^/]+)(?:\/(?:conversation|context))?$/);
  if (agent?.[1]) {
    const id = decodeURIComponent(agent[1]);
    return {
      kind: "agent",
      entityId: id,
      path: `/agents/${agent[1]}`,
      label: shortenId(id),
    };
  }

  const ask = pathname.match(/^\/ask\/([^/]+)$/);
  if (ask?.[1]) {
    const id = decodeURIComponent(ask[1]);
    return {
      kind: "ask",
      entityId: id,
      path: pathname,
      label: shortenId(id),
    };
  }

  const memory = pathname.match(/^\/memory\/([^/]+)$/);
  if (memory?.[1]) {
    const id = decodeURIComponent(memory[1]);
    return {
      kind: "memory",
      entityId: id,
      path: pathname,
      label: shortenId(id),
    };
  }

  const changeset = pathname.match(/^\/changeset\/([^/]+)$/);
  if (changeset?.[1]) {
    const id = decodeURIComponent(changeset[1]);
    return {
      kind: "changeset",
      entityId: id,
      path: pathname,
      label: shortenId(id),
    };
  }

  const task = pathname.match(/^\/tasks\/([^/]+)$/);
  if (task?.[1] && task[1] !== "graph") {
    const id = decodeURIComponent(task[1]);
    return { kind: "task", entityId: id, path: pathname, label: id };
  }

  // mt#4010 — an interceptor detail page. The id is a `guardName`, which is
  // already a readable kebab-case label, so it is NOT shortened the way a uuid
  // is; `shortenId` would turn "turn-end-bare-ref-scan" into a prefix that
  // names nothing. The bare `/interceptors` catalog is a list route, not an
  // entity route, so it deliberately does not match here.
  const interceptor = pathname.match(/^\/interceptors\/([^/]+)$/);
  if (interceptor?.[1]) {
    const id = decodeURIComponent(interceptor[1]);
    return { kind: "interceptor", entityId: id, path: pathname, label: id };
  }

  return null;
}

interface TabsContextValue {
  tabs: EntityTab[];
  /** Path of the active tab, or null when the current route is not an entity route. */
  activePath: string | null;
  /**
   * Close a tab. When closing the tab you're currently on, focus moves to
   * `opts.navigateTo` when given (e.g. a consumable entity settling back to
   * its list — mt#2410's ask-resolution convention), else the last remaining
   * tab, else the default landing.
   */
  closeTab: (path: string, opts?: { navigateTo?: string }) => void;
  /**
   * Close every tab and return to the default landing (mt#3252). The strip's
   * bulk-release gesture — the counterpart to open-on-visit's bulk-acquire.
   */
  closeAllTabs: () => void;
  /**
   * Close every tab except `path`, and navigate to it (mt#3252). Keeping the
   * kept tab active is the point of the gesture: "just this one".
   */
  closeOtherTabs: (path: string) => void;
  /**
   * Mark the tab at `path` as unresolved — its entity 404s (mt#2769). Sets
   * `EntityTab.error`, which `TabBar` renders as an error chip; the tab is
   * EXCLUDED from persistence (see the persist effect below) so a reload does
   * NOT resurrect it. Does not navigate — the caller is presumably already
   * rendering that route's own error state and should stay there.
   */
  markTabError: (path: string) => void;
  /**
   * Activate the tab one step from the active one and return its path, or null
   * when the move is a no-op (mt#3469).
   *
   * `"positional"` is stateless — each call recomputes strip order, so nothing
   * needs releasing afterwards. `"mru"` opens a CYCLE: the recency order is
   * captured on the first call and frozen until `commitTabCycle`, because the
   * open-on-visit effect stamps `lastActiveAt` on every navigation and would
   * otherwise re-sort the order between keypresses — making a second press
   * return to where the first started. This is why VS Code holds its ⌃Tab order
   * until the modifier is released; the caller must mirror that by calling
   * `commitTabCycle` on keyup.
   */
  activateRelativeTab: (direction: TabCycleDirection, mode: TabCycleMode) => string | null;
  /**
   * Release a held MRU cycle: drop the frozen order and stamp the tab the cycle
   * landed on as most-recent. Idempotent, and a no-op when no cycle is open —
   * so it is safe to call from a bare `keyup` or a window `blur` handler.
   */
  commitTabCycle: () => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

/**
 * Predicate for the set of entity tab kinds accepted by the persistence
 * loader. Exported for test-time verification without mocking localStorage.
 */
export function isAcceptedTabKind(kind: unknown): kind is EntityTabKind {
  return (
    kind === "task" ||
    kind === "session" ||
    kind === "agent" ||
    kind === "ask" ||
    kind === "memory" ||
    kind === "changeset" ||
    // Omitting a kind here does NOT just skip one tab — this filter runs at
    // load, so an unlisted kind is dropped from the restored set: the tab works
    // for the session and silently disappears on the next reload.
    kind === "driven" ||
    kind === "interceptor"
  );
}

const LEGACY_SESSION_PATH_RE = /^\/session\/([^/]+)$/;

/**
 * Migrate a persisted tab from the pre-mt#2686 `/session/:id` path to the
 * renamed `/conversation/:id` route (mt#2769 success criterion 1b). The
 * `/session/:id` route registration is gone (replaced by a redirect,
 * App.tsx's `SessionIdRedirect`), so a tab persisted before the rename would
 * otherwise sit as a dead link in the tab strip forever — visiting it 404s
 * silently since no exact route matches, but the tab itself is never
 * refreshed to reflect that. `kind` and `entityId` are left untouched (the
 * segment is already path-encoded, matching what `path` expects); see the
 * `matchEntityRoute` header comment on why "session" stays the kind for
 * conversation tabs pending a broader tab-kind rename.
 *
 * Exported for direct unit testing without mocking localStorage.
 */
export function migrateLegacySessionPath(tab: EntityTab): EntityTab {
  const match = tab.path.match(LEGACY_SESSION_PATH_RE);
  if (!match?.[1]) return tab;
  return { ...tab, path: `/conversation/${match[1]}` };
}

/**
 * Drop later duplicates by `path` (stable — keeps the FIRST occurrence).
 * Guards against a legacy `/session/:id` tab and its already-migrated
 * `/conversation/:id` sibling coexisting in storage after migration.
 */
function dedupeTabsByPath(tabs: EntityTab[]): EntityTab[] {
  const seen = new Set<string>();
  const out: EntityTab[] = [];
  for (const t of tabs) {
    if (seen.has(t.path)) continue;
    seen.add(t.path);
    out.push(t);
  }
  return out;
}

/**
 * Back-fill `lastActiveAt` for tabs persisted before the field existed, and
 * repair non-finite values (a hand-edited or truncated payload).
 *
 * The synthetic recency is the tab's ORDINAL position in the persisted array —
 * open order, the only recency proxy a legacy payload carries. Ordinals are
 * necessarily smaller than any real epoch-ms timestamp, so a back-filled tab
 * always ranks older than one activated in this session: the cap sheds history
 * before it sheds live work.
 *
 * Exported for direct unit testing without mocking localStorage.
 */
export function backfillTabRecency(tabs: EntityTab[]): EntityTab[] {
  return tabs.map((tab, index) =>
    typeof tab.lastActiveAt === "number" && Number.isFinite(tab.lastActiveAt)
      ? tab
      : { ...tab, lastActiveAt: index }
  );
}

function loadTabs(): EntityTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const accepted = parsed.filter(
      (t): t is EntityTab =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as EntityTab).path === "string" &&
        typeof (t as EntityTab).label === "string" &&
        isAcceptedTabKind((t as EntityTab).kind)
    );
    const restored = backfillTabRecency(dedupeTabsByPath(accepted.map(migrateLegacySessionPath)));
    // The cap applies at LOAD, not only when opening tab N+1: an operator
    // arriving with a 49-tab payload persisted by an earlier build must land
    // on a bounded strip, not keep the backlog until they happen to open one
    // more. No tab is protected here — nothing is active yet at load time.
    return evictToCap(restored);
  } catch {
    return [];
  }
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<EntityTab[]>(loadTabs);

  // Persist on every change; storage failures are non-fatal (tabs become
  // session-ephemeral, which is acceptable degradation). Errored tabs
  // (mt#2769 `markTabError`) are excluded — a tab whose entity 404'd must not
  // resurrect on reload.
  useEffect(() => {
    try {
      const persistable = tabs.filter((t) => !t.error);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch {
      /* ignore */
    }
  }, [tabs]);

  // Frozen order for a held MRU cycle (mt#3469); null when no cycle is open.
  // Its non-null-ness doubles as the "suppress recency stamping" flag read by
  // the open-on-visit effect below.
  const cycleRef = useRef<{ paths: string[]; index: number } | null>(null);

  // Open-on-visit: navigating to an entity route ensures its tab exists, and
  // stamps it as the most-recently-active (the LRU key). The set is then
  // trimmed to MAX_OPEN_TABS, protecting the tab just navigated to.
  useEffect(() => {
    const match = matchEntityRoute(pathname);
    if (!match) return;
    // A held MRU cycle walks a frozen order, so stamping each tab as the cycle
    // passes THROUGH it would re-sort that order mid-cycle. Only the STAMP is
    // suppressed, never tab creation: this effect is what guarantees an entity
    // route always has a tab, and a navigation can land here mid-cycle without
    // being part of the cycle at all — a rail click with Control still held, or
    // any path taken after a `keyup` we never received (focus moved between the
    // keydown and the release). Skipping wholesale would drop those tabs on the
    // floor, and in the missed-keyup case would keep dropping them for as long
    // as the stale flag survived. `commitTabCycle` stamps the landed tab once.
    const cycle = cycleRef.current;
    const inCycle = cycle?.paths.includes(match.path) ?? false;
    // Landing outside the frozen order means this navigation is not a cycle
    // step, so the cycle is over regardless of whether its keyup arrived.
    if (cycle && !inCycle) cycleRef.current = null;
    const now = Date.now();
    setTabs((prev) => {
      const existing = prev.find((t) => t.path === match.path);
      if (existing && inCycle) return prev;
      const next = existing
        ? prev.map((t) => (t.path === match.path ? { ...t, lastActiveAt: now } : t))
        : [...prev, { ...match, lastActiveAt: now }];
      return evictToCap(next, { protectPath: match.path });
    });
  }, [pathname]);

  const activePath = useMemo(() => {
    const match = matchEntityRoute(pathname);
    return match ? match.path : null;
  }, [pathname]);

  const closeTab = useCallback(
    (path: string, opts?: { navigateTo?: string }) => {
      setTabs((prev) => {
        const remaining = prev.filter((t) => t.path !== path);
        // Closing the tab you're on: move focus to the caller's destination,
        // or the last remaining tab, or the default landing when the working
        // set is empty.
        if (path === pathname) {
          const next = remaining[remaining.length - 1];
          navigate(opts?.navigateTo ?? (next ? next.path : "/"));
        }
        return remaining;
      });
    },
    [navigate, pathname]
  );

  const closeAllTabs = useCallback(() => {
    setTabs([]);
    navigate("/");
  }, [navigate]);

  const closeOtherTabs = useCallback(
    (path: string) => {
      setTabs((prev) => prev.filter((t) => t.path === path));
      if (path !== pathname) navigate(path);
    },
    [navigate, pathname]
  );

  const markTabError = useCallback((path: string) => {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, error: true } : t)));
  }, []);

  const activateRelativeTab = useCallback(
    (direction: TabCycleDirection, mode: TabCycleMode): string | null => {
      if (tabs.length < 2) return null;

      if (mode === "positional") {
        const target = stepInOrder(
          tabs.map((t) => t.path),
          activePath,
          direction
        );
        if (target) navigate(target);
        return target;
      }

      // Reuse the open cycle's frozen order if one is already running; capture
      // a fresh one otherwise. Starting at -1 when the operator is on a
      // non-entity route makes the first "next" land on index 0 (the most
      // recent tab) rather than skipping past it.
      const cycle = cycleRef.current ?? {
        paths: mruOrderedPaths(tabs, activePath),
        index: activePath === null ? -1 : 0,
      };
      const n = cycle.paths.length;
      if (n < 2) return null;
      const delta = direction === "next" ? 1 : -1;
      const index = (cycle.index + delta + n + n) % n;
      const target = cycle.paths[index] ?? null;
      if (!target) return null;
      cycleRef.current = { paths: cycle.paths, index };
      navigate(target);
      return target;
    },
    [tabs, activePath, navigate]
  );

  const commitTabCycle = useCallback(() => {
    const cycle = cycleRef.current;
    cycleRef.current = null;
    const landed = cycle?.paths[cycle.index];
    if (!landed) return;
    const now = Date.now();
    setTabs((prev) => prev.map((t) => (t.path === landed ? { ...t, lastActiveAt: now } : t)));
  }, []);

  const value = useMemo(
    () => ({
      tabs,
      activePath,
      closeTab,
      closeAllTabs,
      closeOtherTabs,
      markTabError,
      activateRelativeTab,
      commitTabCycle,
    }),
    [
      tabs,
      activePath,
      closeTab,
      closeAllTabs,
      closeOtherTabs,
      markTabError,
      activateRelativeTab,
      commitTabCycle,
    ]
  );

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error("useTabs must be used within a TabsProvider");
  }
  return ctx;
}
