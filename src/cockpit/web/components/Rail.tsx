/**
 * Rail — the Cockpit's persistent left navigation spine (mt#2397), now with
 * a mobile breakpoint (mt#2604).
 *
 * Section order encodes the resolved default-lens axis (mt#2370):
 *   0. New conversation         (the create action — mt#3464)
 *   1. pinned Attention digest  (what needs you — the algedonic top slot)
 *   2. Workstreams              (the workstream-primary spine)
 *   3. divider
 *   4. Browse                   (flat entity entry points)
 *   5. footer                   (settings + running commit)
 *
 * Slot 0 sits ABOVE the nav landmark, not inside it, and does not displace
 * mt#2370's pinned Attention digest: the digest is still the first NAV item,
 * while slot 0 is an ACTION band (the Claude/ChatGPT sidebar-top "New chat"
 * position). It is mirrored into the mobile drawer the same way
 * `ProjectSelector` is, so the two surfaces cannot drift.
 *
 * Responsive behavior (mt#2604): the fixed-width persistent rail has no
 * mobile consideration at 240px it consumes 61% of a 390px viewport, leaving
 * <main> illegibly narrow. Below the `md` breakpoint (768px) the persistent
 * `<aside>` is replaced by a slim top bar (wordmark + hamburger trigger) and
 * a hamburger-triggered slide-in drawer carrying the SAME nav content —
 * chosen over a bottom tab bar because the rail has ~13 destinations
 * (Attention, 2 spine items, 9 browse items, Settings), too many to compress
 * into a handful of always-visible tabs without an arbitrary "top 4" cut.
 * `RailHeader`/`RailNav`/`RailFooter` are shared between the desktop
 * `<aside>` and the mobile drawer so the two surfaces can never drift. At
 * `md` and up, rendering (including CSS classes) is unchanged from mt#2397 —
 * no desktop regression. The drawer uses Radix's Dialog primitive
 * (`@radix-ui/react-dialog`, already a project dependency via
 * `components/ui/dialog.tsx`) for focus-trap, Escape-to-close, and
 * click-outside-to-close, styled as a left-edge slide-in instead of a
 * centered modal.
 *
 * Collapse (mt#3700): at `md` and up the operator can narrow the `<aside>` from
 * `w-60` to a `w-14` icon rail, via the header toggle or ⌘B, to give a
 * wide-canvas surface (the conversation film view above all) back ~184px. The
 * shared sections each take a `collapsed` prop rather than being duplicated, for
 * the same anti-drift reason the mobile drawer reuses them; the drawer always
 * passes the expanded form, because a slide-in that is already a deliberate
 * gesture has no width to reclaim. Rationale for the chord, the storage key, and
 * the icon-rail-over-hide decision: `lib/rail-collapse.ts`.
 *
 * Three things are deliberately dropped in the collapsed state rather than
 * squeezed into 56px, each because it is recoverable by expanding and none is
 * load-bearing at a glance: the wordmark's home link, `ProjectSelector`, and the
 * footer's build-identity badge. `ProjectSelector` is the one worth naming — an
 * active project filter is then not visible in the rail. It renders `null` below
 * two known projects (the common deployment), and the filter's effect is legible
 * in the filtered data itself; revisit if a multi-project operator trips on it.
 * The new-conversation error alert is NOT dropped: it is the only surface a
 * failed launch has, which is the mt#3464 / PR #2477 R1 lesson.
 */
import { useState, useEffect, useCallback, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  GitBranch,
  GitPullRequest,
  Network,
  Bot,
  MessageCircleQuestion,
  Bell,
  Cpu,
  Brain,
  Layers,
  Settings,
  Zap,
  Activity,
  History,
  Menu,
  X,
  Wrench,
  PanelLeftClose,
  PanelLeftOpen,
  Share2,
  ShieldCheck,
  Shield,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useOpenAskCount } from "../hooks/useOpenAskCount";
import { LoadingState } from "./LoadingState";
import { ErrorState } from "./ErrorState";
import { ProjectSelector } from "./ProjectSelector";
import { NewConversationButton } from "./NewConversationButton";
import {
  RAIL_COLLAPSE_HINT,
  loadPersistedRailCollapsed,
  matchesRailCollapseShortcut,
  persistRailCollapsed,
  railToggleLabel,
} from "../lib/rail-collapse";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
}

/** The workstream-primary spine (default-lens axis per mt#2370). */
const SPINE: NavItem[] = [
  { to: "/workstreams", label: "Workstreams", icon: GitBranch },
  // mt#2869 — the temporal complement to the live workstreams view: "what
  // happened across the fleet today," Tier-1-shaped, pull-only.
  { to: "/digest", label: "Digest", icon: History },
];

/** Flat entity entry points below the spine. */
const BROWSE: NavItem[] = [
  { to: "/tasks", label: "Tasks", icon: Network },
  { to: "/changesets", label: "Changesets", icon: GitPullRequest },
  // mt#2767 — the standalone-transcripts nav item was removed; `/agents` is
  // now the unified agent-run browse surface (workspace sessions, harness
  // transcripts, and subagent groups all in one list). Transcripts remain
  // Cmd-K-findable via the CommandPalette's entity index (mt#2769), which
  // reads the context-inspector source directly rather than via this rail.
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/asks", label: "Asks", icon: MessageCircleQuestion },
  // mt#3331 — the EngProd toil-miner's curation-gate digest: filed proposal
  // tasks grouped by mining run, with accept/reject wiring.
  { to: "/proposals", label: "Proposals", icon: Wrench },
  { to: "/activity", label: "Activity", icon: Bell },
  { to: "/embeddings", label: "Embeddings", icon: Cpu },
  { to: "/memories", label: "Memories", icon: Brain },
  // mt#4024 — the inventory of conversations published as public read-only
  // links. In the rail rather than Cmd-K-only because it answers a standing
  // question about exposure ("what is readable right now"), which the operator
  // has to be able to find without already knowing the page exists.
  { to: "/shares", label: "Shared links", icon: Share2 },
  { to: "/plant", label: "Plant", icon: Layers },
  // mt#4229 — the enforcement corpus: what intercepts, where on the turn, and
  // what each one costs. Same reasoning as `/shares` above: it answers a
  // standing question ("what is enforcing right now, and is it healthy") that
  // the operator cannot ask if they have to already know the page exists. It
  // shipped in mt#4010 reachable only by typing the URL, while `/plant`'s
  // drill-down — the older, file-walk view of the same corpus — WAS in the
  // rail. Sits beside Plant because that drill-down now redirects here.
  { to: "/interceptors", label: "Interceptors", icon: ShieldCheck },
  // mt#4287 — the OPERATOR rendering of the same corpus the entry above
  // renders for the maintainer (mem#802's two-audience split). Both are in the
  // rail deliberately: they answer different questions for the same person
  // wearing different hats — "is the corpus healthy and what needs tuning"
  // above, "what is this protecting me from and what is it charging me" here —
  // and routing the second through the first would make the operator read the
  // machinery to reach the outcome, which is the split's whole point.
  // Route name is a PLACEHOLDER pending the naming ask (SC7).
  { to: "/protection", label: "Protection", icon: Shield },
  { to: "/vitals", label: "Vitals", icon: Activity },
];

/**
 * The desktop `<aside>`'s DOM id — the target of the collapse toggle's
 * `aria-controls` (PR #2629 R1). A module constant so the id and the reference
 * cannot drift apart into a dangling IDREF, which resolves to nothing and fails
 * silently in exactly the assistive-tech path it exists to serve.
 */
const RAIL_REGION_ID = "cockpit-rail";

function isActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  // Segment-aware: exact match, or a deeper path UNDER this route — but not a
  // sibling that merely shares a string prefix (e.g. /plant must NOT match
  // /plant-grid, while /agents DOES match /agents/<id>).
  return pathname === to || pathname.startsWith(to + "/");
}

function RailLink({
  item,
  pathname,
  onNavigate,
  collapsed = false,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const Icon = item.icon;
  const active = isActive(pathname, item.to);
  return (
    <Link
      to={item.to}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      // Collapsed, the visible text is gone, so the label has to come from
      // somewhere: `aria-label` for assistive tech, `title` for the pointer.
      // Expanded, both are omitted — the text node IS the accessible name, and
      // duplicating it would only create a second place for a label to drift.
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center rounded-md py-1.5 text-sm transition-colors",
        collapsed ? "justify-center px-0" : "gap-2.5 px-2.5",
        "hover:bg-muted/60",
        active ? "bg-muted text-foreground font-medium" : "text-muted-foreground"
      )}
    >
      <Icon aria-hidden className="h-4 w-4 flex-shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

/**
 * Pinned attention digest — the algedonic top slot, linking to the asks surface.
 *
 * Pending count via the shared `useOpenAskCount` hook (mt#2590's `attention`
 * widget reader), migrated off a bespoke bare `fetch()`+`useState` poll
 * (mt#2641). That prior implementation derived the count from `asks` /
 * `pendingCount` / `count` payload fields that don't exist on the actual
 * `AttentionPayload` shape (`{ activeWindow, cohort, totalPending }`) — so the
 * badge silently rendered "…" forever in production. `useOpenAskCount` reads
 * `totalPending` directly and shares its query cache with every other
 * consumer of the same widget (VitalsPage, PlantFlowPage, AttentionLoopCard).
 */
function AttentionDigest({
  pathname,
  onNavigate,
  collapsed = false,
}: {
  pathname: string;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const { data: count, isLoading, isError } = useOpenAskCount();
  const active = isActive(pathname, "/asks");

  // The pending count is the whole point of the slot, so it rides in the
  // accessible name in BOTH states — collapsed, the compact badge below is a
  // glyph a screen reader would otherwise read as a bare number next to a bare
  // "Attention", and in the loading/error cases there is no badge at all.
  const state = isLoading
    ? "loading"
    : isError
      ? "count unavailable"
      : count != null
        ? `${count} pending`
        : null;
  const label = state ? `Attention — ${state}` : "Attention";

  if (collapsed) {
    return (
      <Link
        to="/asks"
        aria-current={active ? "page" : undefined}
        aria-label={label}
        title={label}
        onClick={onNavigate}
        className={cn(
          "flex items-center justify-center gap-1 rounded-md py-2 text-sm transition-colors",
          "border border-border/60",
          active ? "bg-muted text-foreground" : "hover:bg-muted/60 text-foreground"
        )}
      >
        <Zap aria-hidden className="h-4 w-4 flex-shrink-0 text-warn-amber" />
        {/* Count only, no "clear" word and no chrome — at 56px the number IS the
            signal, and a zero reads fine as an absent badge beside a quiet icon.
            `aria-hidden` because `label` above already says it. */}
        {!isLoading && !isError && count != null && count > 0 && (
          <span
            aria-hidden
            className="text-[10px] font-medium leading-none text-warn-amber tabular-nums"
          >
            {count}
          </span>
        )}
        {isError && (
          <span aria-hidden className="text-[10px] font-medium leading-none text-destructive">
            !
          </span>
        )}
      </Link>
    );
  }

  return (
    <Link
      to="/asks"
      aria-current={active ? "page" : undefined}
      aria-label={label}
      onClick={onNavigate}
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
        "border border-border/60",
        active ? "bg-muted text-foreground" : "hover:bg-muted/60 text-foreground"
      )}
    >
      <span className="flex items-center gap-2 font-medium">
        <Zap aria-hidden className="h-4 w-4 text-warn-amber" />
        Attention
      </span>
      {isLoading ? (
        <LoadingState message="…" className="text-xs" />
      ) : isError ? (
        <ErrorState message="error" ambient className="text-xs" />
      ) : count != null && count > 0 ? (
        <span className="rounded-full bg-warn-amber/20 px-1.5 text-xs font-medium text-warn-amber tabular-nums">
          {count}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">clear</span>
      )}
    </Link>
  );
}

interface HealthResponse {
  commit?: string;
}

/**
 * Running-commit fetch for the footer (mt#2641). `/api/health` isn't a
 * registry widget (no `fetchWidgetData` route), so this hits the endpoint
 * directly, mirroring `useSystemHealth`'s `/api/health` call. Resolves to
 * `null` (not an error) when the server can't determine a commit — e.g. a
 * non-git checkout — since that's a valid degraded state, not a fetch failure.
 */
async function fetchRunningCommit(): Promise<string | null> {
  const res = await fetch("/api/health");
  if (!res.ok) {
    throw new Error(`api/health: ${res.status}`);
  }
  const data = (await res.json()) as HealthResponse;
  return typeof data.commit === "string" && data.commit !== "unknown" ? data.commit : null;
}

/**
 * The bundle's build commit, or `"unknown"` where the build-time define does not
 * exist (mt#3241, PR #2475 R1).
 *
 * `__BUILD_COMMIT__` is a vite `define` — a compile-time TEXT SUBSTITUTION, not a
 * runtime global. Outside a vite build (a `bun test` render, SSR, Storybook) the
 * identifier is undeclared and simply evaluating it throws a `ReferenceError`,
 * confirmed by measurement. `typeof` is the one operator that does NOT throw on
 * an undeclared identifier, so the guard has to be shaped exactly this way — an
 * `?? "unknown"` or a truthiness check would still evaluate the identifier and
 * still throw.
 */
export function readBundleCommit(): string {
  return typeof __BUILD_COMMIT__ === "string" && __BUILD_COMMIT__.length > 0
    ? __BUILD_COMMIT__
    : "unknown";
}

/** What the footer should render for the build identity. `null` = render nothing. */
export interface BuildIdentityDisplay {
  /** The visible text. */
  text: string;
  /** The `title` attribute — where the layer names actually get spelled out. */
  title: string;
  /** True when daemon and bundle disagree; the footer styles this case louder. */
  diverged: boolean;
}

/**
 * Describe the two build identities for the footer (mt#3241).
 *
 * The cockpit has TWO independently-versioned layers, and the badge used to
 * report one of them under the unqualified label "Running commit":
 *
 *  - **daemon** — the server process, from `/api/health`. Its value is captured
 *    once, at the first health call, and frozen for the process lifetime
 *    (`getGitCommit` in `src/cockpit/routes/health.ts`). That is ACCURATE: the
 *    process is running the code it loaded at start.
 *  - **bundle** — the JS the reader is actually looking at, compiled in at build
 *    time (`__BUILD_COMMIT__`). The tray's watcher (mt#2297) rebuilds it WITHOUT
 *    restarting the daemon, so it can be many commits newer.
 *
 * Reporting only the daemon sha invited reading it as "what am I looking at",
 * which cost a diagnostic round on 2026-07-29 (an agent concluded the operator's
 * window was serving a stale bundle; it was not). So: one sha when the layers
 * agree, BOTH when they diverge, and the layer names always in the tooltip.
 *
 * Pure so the three states are testable without a DOM or a live server.
 */
export function describeBuildIdentity(
  daemonCommit: string | null,
  bundleCommit: string
): BuildIdentityDisplay | null {
  const bundle = bundleCommit && bundleCommit !== "unknown" ? bundleCommit : null;

  if (!daemonCommit && !bundle) return null;

  if (!bundle) {
    // Build had no git (Docker, non-git checkout). Report the daemon alone, but
    // still name its layer — the ambiguity this task fixes is the unlabelled sha,
    // and it is no less ambiguous when the other half is unavailable.
    return {
      text: daemonCommit as string,
      title: `Server process built from ${daemonCommit}. Bundle build commit unavailable.`,
      diverged: false,
    };
  }

  if (!daemonCommit) {
    return {
      text: bundle,
      title: `UI bundle built from ${bundle}. Server process commit unavailable.`,
      diverged: false,
    };
  }

  if (daemonCommit === bundle) {
    return {
      text: bundle,
      title: `UI bundle and server process both built from ${bundle}.`,
      diverged: false,
    };
  }

  return {
    text: `ui ${bundle} · svc ${daemonCommit}`,
    title:
      `UI bundle built from ${bundle}; server process built from ${daemonCommit}. ` +
      `These are versioned independently — the bundle is rebuilt without restarting the server, ` +
      `so the server lags until it restarts.`,
    diverged: true,
  };
}

/**
 * The collapse toggle (mt#3700). Lives in the rail header — the position VS
 * Code, Linear, and Notion all put it in, so it is where a hand goes looking —
 * and is the ONLY control that survives into the collapsed header, which is what
 * makes the collapsed state self-reversing without a floating re-entry button.
 *
 * `aria-expanded` describes the rail, not the button, so it is the state; the
 * label names the ACTION the press performs. The hint is `aria-hidden` for the
 * same reason it is on `NewConversationButton`: it must not end up in the
 * accessible name.
 *
 * `aria-controls` names the region that state is ABOUT (PR #2629 R1). Without
 * it, `aria-expanded` sits on a control with no stated referent — a screen
 * reader announces "collapsed" and gives the user no way to reach the thing that
 * collapsed. The referent here is an ANCESTOR of the button, which is unusual
 * but is what the markup actually is: the toggle lives inside the rail it
 * controls, which is exactly what makes the collapsed state self-reversing.
 * `RailHeader` renders only inside the desktop `<aside>` (the drawer builds its
 * own header), so `RAIL_REGION_ID` is unique in the document.
 */
function RailCollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={RAIL_REGION_ID}
      aria-label={railToggleLabel(collapsed)}
      aria-keyshortcuts="Meta+B"
      title={`${railToggleLabel(collapsed)} (${RAIL_COLLAPSE_HINT})`}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon aria-hidden className="h-4 w-4" />
    </button>
  );
}

/** Header row: wordmark + ⌘K hint + collapse toggle. Desktop `<aside>` only —
 * the mobile top bar renders its own compact wordmark + hamburger trigger
 * instead. Collapsed, only the toggle remains: the wordmark and the ⌘K hint are
 * both wider than the rail, and neither is an affordance the operator loses
 * (⌘K still works, and home is one expand away). */
function RailHeader({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  if (collapsed) {
    return (
      <div className="flex h-14 flex-shrink-0 items-center justify-center border-b border-border px-1">
        <RailCollapseToggle collapsed={collapsed} onToggle={onToggle} />
      </div>
    );
  }

  return (
    <div className="flex h-14 flex-shrink-0 items-center justify-between gap-1 border-b border-border px-3">
      <Link
        to="/"
        aria-label="Minsky Cockpit home"
        className="flex items-center gap-1 hover:opacity-80 transition-opacity"
      >
        <span className="font-mono text-sm font-semibold text-primary">Minsky</span>
        <span className="text-sm font-medium text-muted-foreground">Cockpit</span>
      </Link>
      <div className="flex flex-shrink-0 items-center gap-1">
        <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          ⌘K
        </kbd>
        <RailCollapseToggle collapsed={collapsed} onToggle={onToggle} />
      </div>
    </div>
  );
}

/** Nav sections (attention digest, spine, divider, browse). Shared between
 * the desktop `<aside>` and the mobile drawer; `onNavigate` (present only in
 * the drawer) closes the drawer on link activation. */
function RailNav({
  pathname,
  onNavigate,
  collapsed = false,
}: {
  pathname: string;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  return (
    <nav
      className={cn("flex flex-1 flex-col gap-1 overflow-y-auto py-2", collapsed ? "px-1" : "p-2")}
      aria-label="Sections"
    >
      {/* 1. Pinned attention digest */}
      <AttentionDigest pathname={pathname} onNavigate={onNavigate} collapsed={collapsed} />

      {/* 2. Workstream-primary spine */}
      <div className="mt-1 flex flex-col gap-1">
        {SPINE.map((item) => (
          <RailLink
            key={item.to}
            item={item}
            pathname={pathname}
            onNavigate={onNavigate}
            collapsed={collapsed}
          />
        ))}
      </div>

      {/* 3. Divider */}
      <div className="my-2 border-t border-border/50" />

      {/* 4. Browse entity entry points. Collapsed, the eyebrow is dropped and the
             divider above carries the grouping alone — a 10px uppercase word does
             not survive 56px, and truncating it to "BRO…" would be worse than the
             rule that already separates the two groups. */}
      {!collapsed && (
        <div className="px-2.5 pb-1 text-eyebrow font-mono uppercase text-muted-foreground/60">
          Browse
        </div>
      )}
      <div className="flex flex-col gap-1">
        {BROWSE.map((item) => (
          <RailLink
            key={item.to}
            item={item}
            pathname={pathname}
            onNavigate={onNavigate}
            collapsed={collapsed}
          />
        ))}
      </div>
    </nav>
  );
}

/** Footer: settings + running commit. Shared between the desktop `<aside>`
 * and the mobile drawer (see `RailNav` for the `onNavigate` contract). */
function RailFooter({
  pathname,
  onNavigate,
  collapsed = false,
}: {
  pathname: string;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const commitQuery = useQuery({
    queryKey: ["rail", "running-commit"],
    queryFn: fetchRunningCommit,
    staleTime: 5 * 60_000,
  });

  // Collapsed, the footer is the Settings icon alone. The build-identity badge
  // is dropped rather than abbreviated: it is already a 10px badge whose meaning
  // lives entirely in its `title`, and a hover-only tooltip on an unlabelled
  // 3-character sha is not information, it is a puzzle. Expanding restores it.
  if (collapsed) {
    return (
      <div className="flex flex-shrink-0 items-center justify-center border-t border-border px-1 py-2">
        <Link
          to="/settings"
          aria-current={isActive(pathname, "/settings") ? "page" : undefined}
          aria-label="Settings"
          title="Settings"
          onClick={onNavigate}
          className={cn(
            "flex items-center justify-center rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60",
            isActive(pathname, "/settings") ? "text-foreground" : "text-muted-foreground"
          )}
        >
          <Settings aria-hidden className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-shrink-0 items-center justify-between border-t border-border px-2.5 py-2">
      <Link
        to="/settings"
        aria-current={isActive(pathname, "/settings") ? "page" : undefined}
        onClick={onNavigate}
        className={cn(
          "flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted/60",
          isActive(pathname, "/settings") ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <Settings aria-hidden className="h-4 w-4" />
        <span>Settings</span>
      </Link>
      {commitQuery.isLoading ? (
        <LoadingState message="…" className="text-[10px]" />
      ) : commitQuery.isError ? (
        <ErrorState message="commit unknown" ambient className="text-[10px]" />
      ) : (
        (() => {
          // The daemon commit may be null (server reported "unknown") while the
          // bundle's is still known, so this is NOT gated on commitQuery.data —
          // doing so would drop the half that answers "what am I looking at".
          const identity = describeBuildIdentity(commitQuery.data ?? null, readBundleCommit());
          if (!identity) return null;
          return (
            <span
              data-testid="rail-build-identity"
              className={cn(
                "font-mono text-[10px]",
                // Diverged is not an error — it is the normal state between a
                // bundle rebuild and the next daemon restart — so it reads a step
                // stronger than the agreed case, not alarming.
                identity.diverged ? "text-muted-foreground/80" : "text-muted-foreground/50"
              )}
              title={identity.title}
              // The visible text abbreviates to fit a 10px footer, so the full
              // sentence is carried here as well as in `title` — a tooltip is
              // unreachable by touch and by assistive tech, which would leave the
              // abbreviations as the only available meaning (PR #2475 R1).
              aria-label={identity.title}
            >
              {identity.text}
            </span>
          );
        })()
      )}
    </div>
  );
}

export function Rail() {
  const { pathname } = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(loadPersistedRailCollapsed);

  // Close the drawer whenever the route changes (link clicks also call
  // onNavigate directly, but this covers back/forward nav and any path we
  // missed wiring onClick to).
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => !current);
  }, []);

  useEffect(() => {
    persistRailCollapsed(collapsed);
  }, [collapsed]);

  // ⌘B from anywhere. `Rail` is mounted on every route inside `Layout`, so it
  // owns the binding directly rather than needing a `TabKeyboardNav`-style
  // render-nothing sibling — that component exists only because it has to sit
  // inside `TabsProvider` to reach `useTabs`, which this state does not.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!matchesRailCollapseShortcut(e)) return;
      e.preventDefault();
      toggleCollapsed();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleCollapsed]);

  return (
    <>
      {/* Mobile top bar (below `md`) — wordmark + hamburger trigger for the
          slide-in drawer. Hidden entirely at `md` and up. */}
      <div className="flex h-14 w-full flex-shrink-0 items-center justify-between border-b border-border bg-background px-3 md:hidden">
        <Link
          to="/"
          aria-label="Minsky Cockpit home"
          className="flex items-center gap-1 hover:opacity-80 transition-opacity"
        >
          <span className="font-mono text-sm font-semibold text-primary">Minsky</span>
          <span className="text-sm font-medium text-muted-foreground">Cockpit</span>
        </Link>
        <button
          type="button"
          aria-label="Open navigation"
          aria-haspopup="dialog"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen(true)}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Menu aria-hidden className="h-5 w-5" />
        </button>
      </div>

      {/* Desktop persistent rail (`md` and up) — mt#2397, plus the mt#3700
          collapse. The width animates under `motion-safe` only, so a
          reduced-motion preference gets the instant snap rather than a JS
          media-query hook; nothing else about the transition needs to be
          conditional. */}
      <aside
        id={RAIL_REGION_ID}
        aria-label="Primary navigation"
        className={cn(
          "hidden h-full flex-shrink-0 flex-col border-r border-border bg-background md:flex",
          "motion-safe:transition-[width] motion-safe:duration-200",
          collapsed ? "w-14" : "w-60"
        )}
      >
        <RailHeader collapsed={collapsed} onToggle={toggleCollapsed} />
        {/* Project selector (mt#2418) — shell-level filter, shared between
            desktop and mobile (see the mirrored insertion in the drawer
            below) so the two surfaces can't drift. Renders its own wrapper
            (or null for a single-project deployment) so no empty bordered
            strip appears when there is nothing to select. Hidden while
            collapsed — see this file's header comment for that tradeoff. */}
        {!collapsed && <ProjectSelector />}
        {/* Create action (mt#3464) — mirrored into the drawer below. */}
        <NewConversationButton collapsed={collapsed} />
        <RailNav pathname={pathname} collapsed={collapsed} />
        <RailFooter pathname={pathname} collapsed={collapsed} />
      </aside>

      {/* Mobile slide-in drawer — same nav content as the desktop rail,
          triggered by the hamburger button above. Radix Dialog gives us
          focus-trap, Escape-to-close, and click-outside-to-close for free;
          only the positioning/animation classes differ from a centered
          modal (see components/ui/dialog.tsx for the modal variant). */}
      <DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay
            className={cn(
              "fixed inset-0 z-50 bg-black/60 md:hidden",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            )}
          />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col",
              "border-r border-border bg-background shadow-lg outline-none md:hidden",
              "data-[state=open]:animate-in data-[state=closed]:animate-out duration-200",
              "data-[state=closed]:slide-out-to-left-full data-[state=open]:slide-in-from-left-full"
            )}
          >
            <DialogPrimitive.Title className="sr-only">Primary navigation</DialogPrimitive.Title>
            <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-border px-3">
              <span className="flex items-center gap-1">
                <span className="font-mono text-sm font-semibold text-primary">Minsky</span>
                <span className="text-sm font-medium text-muted-foreground">Cockpit</span>
              </span>
              <DialogPrimitive.Close
                aria-label="Close navigation"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
            {/* Project selector (mt#2418) — mirrors the desktop insertion
                above so the drawer and the persistent rail never drift. */}
            <ProjectSelector />
            {/* Create action (mt#3464) — mirrors the desktop insertion. Takes
                no `onNavigate`, unlike the nav links below: closing the drawer
                on click would unmount the only visible error surface a failed
                launch has (PR #2477 R1). The pathname effect above closes the
                drawer when a successful launch navigates. */}
            <NewConversationButton />
            <RailNav pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
            <RailFooter pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
