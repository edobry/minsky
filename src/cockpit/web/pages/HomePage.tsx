/**
 * HomePage — the "/" route.
 *
 * Shows:
 *   - Small cards: BasicHealth, Attention, Credentials (inline from widget registry)
 *   - Summary entry-point tiles for the three promoted pages: Agents, Workstreams, Tasks
 *
 * Entry tiles are intentionally dense: they show a brief description and a
 * "View" link — operator scans the tile to decide whether to drill in.
 */
import { Link } from "react-router-dom";
import { Bot, GitBranch, Network, ArrowRight } from "lucide-react";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Entry tile — summary card linking to a promoted page
// ---------------------------------------------------------------------------

interface EntryTileProps {
  to: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  label: string;
  description: string;
  /** Optional live count or status string shown as a secondary badge */
  badge?: React.ReactNode;
}

function EntryTile({ to, icon: Icon, label, description, badge }: EntryTileProps) {
  return (
    <Link
      to={to}
      className={cn(
        "group relative flex flex-col gap-2 rounded-lg p-4",
        "border border-border bg-card text-card-foreground",
        "hover:bg-muted/30 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon aria-hidden className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <span className="text-sm font-semibold">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          {badge}
          <ArrowRight
            aria-hidden
            className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground leading-snug">{description}</p>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Promoted pages section
// ---------------------------------------------------------------------------

export function PromotedPageTiles() {
  return (
    <section aria-label="Feature pages">
      <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
        Feature pages
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <EntryTile
          to="/agents"
          icon={Bot}
          label="Agents"
          description="Monitor active agent sessions, liveness status, and PR state."
        />
        <EntryTile
          to="/workstreams"
          icon={GitBranch}
          label="Work Streams"
          description="Collapsible view of parent tasks with active, done, and blocked child counts."
        />
        <EntryTile
          to="/tasks"
          icon={Network}
          label="Task Graph"
          description="Interactive dependency DAG of all Minsky tasks — pan, zoom, and click to inspect."
        />
      </div>
    </section>
  );
}
