/**
 * Rail — the Cockpit's persistent left navigation spine (mt#2397).
 *
 * Replaces the hamburger → NavSheet slide-in overlay with an always-visible
 * rail. Section order encodes the resolved default-lens axis (mt#2370):
 *   1. pinned Attention digest  (what needs you — the algedonic top slot)
 *   2. Workstreams              (the workstream-primary spine)
 *   3. divider
 *   4. Browse                   (flat entity entry points)
 *   5. footer                   (settings + running commit)
 *
 * The rail is the navigation spine for the first shell view (rail+tabs). It is
 * a single composition; a future view (e.g. a CEO status-board) supplies a
 * different spine without touching the widgets it routes to (Layout-flexibility
 * mandate). The ⌘K hint here is served by the existing global CommandPalette.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import {
  GitBranch,
  GitPullRequest,
  Network,
  Bot,
  FileSearch,
  MessageCircleQuestion,
  MessagesSquare,
  Bell,
  Cpu,
  Brain,
  Layers,
  Settings,
  Zap,
  Activity,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useOpenAskCount } from "../hooks/useOpenAskCount";
import { LoadingState } from "./LoadingState";
import { ErrorState } from "./ErrorState";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
}

/** The workstream-primary spine (default-lens axis per mt#2370). */
const SPINE: NavItem[] = [{ to: "/workstreams", label: "Workstreams", icon: GitBranch }];

/** Flat entity entry points below the spine. */
const BROWSE: NavItem[] = [
  { to: "/tasks", label: "Tasks", icon: Network },
  { to: "/changesets", label: "Changesets", icon: GitPullRequest },
  { to: "/sessions", label: "Conversations", icon: MessagesSquare },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/context", label: "Context", icon: FileSearch },
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

function RailLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  const active = isActive(pathname, item.to);
  return (
    <Link
      to={item.to}
      aria-current={active ? "page" : undefined}
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
function AttentionDigest({ pathname }: { pathname: string }) {
  const { data: count, isLoading, isError } = useOpenAskCount();
  const active = isActive(pathname, "/asks");
  return (
    <Link
      to="/asks"
      aria-current={active ? "page" : undefined}
      aria-label={`Attention${count != null ? ` — ${count} pending` : ""}`}
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

export function Rail() {
  const { pathname } = useLocation();
  const commitQuery = useQuery({
    queryKey: ["rail", "running-commit"],
    queryFn: fetchRunningCommit,
    staleTime: 5 * 60_000,
  });

  return (
    <aside
      aria-label="Primary navigation"
      className="flex h-full w-60 flex-shrink-0 flex-col border-r border-border bg-background"
    >
      {/* Header: wordmark + ⌘K hint (palette is the existing global CommandPalette) */}
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

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2" aria-label="Sections">
        {/* 1. Pinned attention digest */}
        <AttentionDigest pathname={pathname} />

        {/* 2. Workstream-primary spine */}
        <div className="mt-1 flex flex-col gap-1">
          {SPINE.map((item) => (
            <RailLink key={item.to} item={item} pathname={pathname} />
          ))}
        </div>

        {/* 3. Divider */}
        <div className="my-2 border-t border-border/50" />

        {/* 4. Browse entity entry points */}
        <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          Browse
        </div>
        <div className="flex flex-col gap-1">
          {BROWSE.map((item) => (
            <RailLink key={item.to} item={item} pathname={pathname} />
          ))}
        </div>
      </nav>

      {/* 5. Footer: settings + running commit */}
      <div className="flex flex-shrink-0 items-center justify-between border-t border-border px-2.5 py-2">
        <Link
          to="/settings"
          aria-current={isActive(pathname, "/settings") ? "page" : undefined}
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
    </aside>
  );
}
