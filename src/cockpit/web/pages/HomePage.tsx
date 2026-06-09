/**
 * HomePage — the "/" route.
 *
 * Structure (operator journey order):
 *   1. System section  — compact status cards (BasicHealth, Attention, CredentialsSummary)
 *      inside a subtle bordered panel; rendered by App.tsx's HomePage component.
 *      Full interactive tools (Context Inspector, etc.) have their own page routes.
 *   2. Nav section — generous tiles linking to the feature pages.
 *      Exported here as PageNavTiles, consumed by App.tsx.
 *
 * The two sections are intentionally different in visual weight:
 *   System  = dense, data-first cards enclosed in a muted bordered panel
 *   Nav     = spacious tiles with icon + description + arrow affordance
 *
 * Categorization is signaled by surface/shape (bordered panel vs. plain tiles),
 * not by eyebrow labels. The `<section aria-label>` attributes provide the
 * accessibility structure screen readers need without visible headings.
 */
import { Link } from "react-router-dom";
import { Bot, Brain, FileSearch, GitBranch, List, Network, MessageCircleQuestion, Bell, Cpu, Layers, ChevronRight } from "lucide-react";
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
        <Icon
          aria-hidden
          className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors"
        />
      </div>

      {/* Label + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{label}</span>
          {badge}
        </div>
        <p className="text-xs text-muted-foreground leading-snug mt-0.5">{description}</p>
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

export function PageNavTiles() {
  return (
    <section aria-label="Navigate to feature pages">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <EntryTile
          to="/agents"
          icon={Bot}
          label="Agents"
          description="Active sessions, liveness, and PR state"
        />
        <EntryTile
          to="/context"
          icon={FileSearch}
          label="Context"
          description="Session context blocks, filters, and content viewer"
        />
        <EntryTile
          to="/workstreams"
          icon={GitBranch}
          label="Workstreams"
          description="Parent tasks with child status counts"
        />
        <EntryTile
          to="/tasks"
          icon={List}
          label="Task List"
          description="Sortable, filterable task table"
        />
        <EntryTile
          to="/tasks/graph"
          icon={Network}
          label="Task Graph"
          description="Interactive task dependency DAG"
        />
        <EntryTile
          to="/asks"
          icon={MessageCircleQuestion}
          label="Asks"
          description="Respond to pending principal-attention asks"
        />
        <EntryTile
          to="/activity"
          icon={Bell}
          label="Activity"
          description="System event log — what happened while you were away"
        />
        <EntryTile
          to="/embeddings"
          icon={Cpu}
          label="Embeddings"
          description="Provider health, index coverage, and error log"
        />
        <EntryTile
          to="/memories"
          icon={Brain}
          label="Memories"
          description="Browse, search, and inspect memory records"
        />
        <EntryTile
          to="/plant"
          icon={Layers}
          label="Plant Board"
          description="VSM whole-system schematic — organs, flow, attention seam"
        />
      </div>
    </section>
  );
}