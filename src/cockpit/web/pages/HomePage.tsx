/**
 * HomePage — the "/" route.
 *
 * Structure (operator journey order):
 *   1. SYSTEM section  — compact status cards (BasicHealth, Attention, Credentials)
 *      rendered by App.tsx's HomePage component directly.
 *   2. NAVIGATE section — generous nav tiles for the three promoted pages.
 *      Exported here as PromotedPageTiles, consumed by App.tsx.
 *
 * The two sections are intentionally different in visual weight:
 *   SYSTEM  = dense, data-first, single-metric cards (mission-control density)
 *   NAVIGATE = spacious tiles with icon + description + arrow affordance
 *
 * Eyebrow labels ("SYSTEM" / "NAVIGATE") are wayfinding, not headings.
 * They use `<p>` — not `<h2>` — to avoid implying section hierarchy.
 */
import { Link } from "react-router-dom";
import { Bot, GitBranch, Network, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Entry tile — generous nav card linking to a promoted page
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
        "group relative flex items-center gap-4 rounded-lg px-4 py-3.5",
        "border border-border bg-card text-card-foreground",
        // Hover: subtle background lift + border accent
        "hover:bg-card/80 hover:border-border/80 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      {/* Icon container — slightly elevated surface feel */}
      <div className="flex-shrink-0 flex items-center justify-center h-9 w-9 rounded-md bg-muted/60 group-hover:bg-muted transition-colors">
        <Icon aria-hidden className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
      </div>

      {/* Label + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{label}</span>
          {badge}
        </div>
        <p className="text-xs text-muted-foreground leading-snug mt-0.5 truncate">{description}</p>
      </div>

      {/* Arrow affordance — grows more visible on hover */}
      <ChevronRight
        aria-hidden
        className="flex-shrink-0 h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors"
      />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Promoted pages section — exported for use in App.tsx
// ---------------------------------------------------------------------------

export function PromotedPageTiles() {
  return (
    <section aria-label="Navigate to feature pages">
      {/* Eyebrow label — wayfinding, not a heading */}
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
        Navigate
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <EntryTile
          to="/agents"
          icon={Bot}
          label="Agents"
          description="Monitor active agent sessions, liveness status, and PR state."
        />
        <EntryTile
          to="/workstreams"
          icon={GitBranch}
          label="Workstreams"
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
