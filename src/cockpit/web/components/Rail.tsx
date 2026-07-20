/**
 * Rail — the Cockpit's persistent left navigation spine (mt#2397), now with
 * a mobile breakpoint (mt#2604).
 *
 * Section order encodes the resolved default-lens axis (mt#2370):
 *   1. pinned Attention digest  (what needs you — the algedonic top slot)
 *   2. Workstreams              (the workstream-primary spine)
 *   3. divider
 *   4. Browse                   (flat entity entry points)
 *   5. footer                   (settings + running commit)
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
 */
import { useState, useEffect, type ComponentType } from "react";
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
} from "lucide-react";
import { cn } from "../lib/utils";
import { useOpenAskCount } from "../hooks/useOpenAskCount";
import { LoadingState } from "./LoadingState";
import { ErrorState } from "./ErrorState";
import { ProjectSelector } from "./ProjectSelector";

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
  { to: "/activity", label: "Activity", icon: Bell },
  { to: "/embeddings", label: "Embeddings", icon: Cpu },
  { to: "/memories", label: "Memories", icon: Brain },
  { to: "/plant", label: "Plant", icon: Layers },
  { to: "/vitals", label: "Vitals", icon: Activity },
];

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
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const active = isActive(pathname, item.to);
  return (
    <Link
      to={item.to}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
        "hover:bg-muted/60",
        active ? "bg-muted text-foreground font-medium" : "text-muted-foreground"
      )}
    >
      <Icon aria-hidden className="h-4 w-4 flex-shrink-0" />
      <span className="truncate">{item.label}</span>
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
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  const { data: count, isLoading, isError } = useOpenAskCount();
  const active = isActive(pathname, "/asks");
  return (
    <Link
      to="/asks"
      aria-current={active ? "page" : undefined}
      aria-label={`Attention${count != null ? ` — ${count} pending` : ""}`}
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

/** Header row: wordmark + ⌘K hint. Desktop `<aside>` only — the mobile top
 * bar renders its own compact wordmark + hamburger trigger instead. */
function RailHeader() {
  return (
    <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-border px-3">
      <Link
        to="/"
        aria-label="Minsky Cockpit home"
        className="flex items-center gap-1 hover:opacity-80 transition-opacity"
      >
        <span className="font-mono text-sm font-semibold text-primary">Minsky</span>
        <span className="text-sm font-medium text-muted-foreground">Cockpit</span>
      </Link>
      <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        ⌘K
      </kbd>
    </div>
  );
}

/** Nav sections (attention digest, spine, divider, browse). Shared between
 * the desktop `<aside>` and the mobile drawer; `onNavigate` (present only in
 * the drawer) closes the drawer on link activation. */
function RailNav({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2" aria-label="Sections">
      {/* 1. Pinned attention digest */}
      <AttentionDigest pathname={pathname} onNavigate={onNavigate} />

      {/* 2. Workstream-primary spine */}
      <div className="mt-1 flex flex-col gap-1">
        {SPINE.map((item) => (
          <RailLink key={item.to} item={item} pathname={pathname} onNavigate={onNavigate} />
        ))}
      </div>

      {/* 3. Divider */}
      <div className="my-2 border-t border-border/50" />

      {/* 4. Browse entity entry points */}
      <div className="px-2.5 pb-1 text-eyebrow font-mono uppercase text-muted-foreground/60">
        Browse
      </div>
      <div className="flex flex-col gap-1">
        {BROWSE.map((item) => (
          <RailLink key={item.to} item={item} pathname={pathname} onNavigate={onNavigate} />
        ))}
      </div>
    </nav>
  );
}

/** Footer: settings + running commit. Shared between the desktop `<aside>`
 * and the mobile drawer (see `RailNav` for the `onNavigate` contract). */
function RailFooter({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const commitQuery = useQuery({
    queryKey: ["rail", "running-commit"],
    queryFn: fetchRunningCommit,
    staleTime: 5 * 60_000,
  });

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
        commitQuery.data && (
          <span className="font-mono text-[10px] text-muted-foreground/50" title="Running commit">
            {commitQuery.data}
          </span>
        )
      )}
    </div>
  );
}

export function Rail() {
  const { pathname } = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Close the drawer whenever the route changes (link clicks also call
  // onNavigate directly, but this covers back/forward nav and any path we
  // missed wiring onClick to).
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

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

      {/* Desktop persistent rail (`md` and up) — unchanged from mt#2397. */}
      <aside
        aria-label="Primary navigation"
        className="hidden h-full w-60 flex-shrink-0 flex-col border-r border-border bg-background md:flex"
      >
        <RailHeader />
        {/* Project selector (mt#2418) — shell-level filter, shared between
            desktop and mobile (see the mirrored insertion in the drawer
            below) so the two surfaces can't drift. Renders its own wrapper
            (or null for a single-project deployment) so no empty bordered
            strip appears when there is nothing to select. */}
        <ProjectSelector />
        <RailNav pathname={pathname} />
        <RailFooter pathname={pathname} />
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
            <RailNav pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
            <RailFooter pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}