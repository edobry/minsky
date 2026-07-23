/**
 * Changesets widget — list renderer for active PRs across sessions (mt#1920).
 *
 * Receives the changeset array from ChangesetsPage; renders each row as a
 * clickable button linking to the in-cockpit /changeset/:id detail route.
 * GitHub link-out is a secondary affordance (aria-label, small icon, _blank).
 *
 * CI state column degrades gracefully to "—" — mt#2076/mt#2435 shipped but
 * did not add a CI/check-run field to the session-record source
 * (SessionRecord.pullRequest / SessionPrRef), so there is still no data path
 * to consume here (probed at mt#2561; wire when that data path lands).
 *
 * Density-first, dark-mode-first per cockpit-dev design directives.
 */
import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { relativeTime, changesetRecencyIso } from "../lib/format";
import { changesetDisplayTitle } from "../../session-detail";
import type { SessionPrRef, SessionDetailMeta } from "../../session-detail";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChangesetItem {
  pr: SessionPrRef;
  session: SessionDetailMeta;
}

export interface ChangesetsListResponse {
  changesets: ChangesetItem[];
}

// ---------------------------------------------------------------------------
// PR state chip
// ---------------------------------------------------------------------------

function prStateChip(state: string): { label: string; cls: string } {
  switch (state) {
    case "open":
      return { label: "Open", cls: "bg-green-500/15 text-green-400" };
    case "draft":
      return { label: "Draft", cls: "bg-muted text-muted-foreground" };
    case "merged":
      return { label: "Merged", cls: "bg-violet-500/15 text-violet-400" };
    case "closed":
      return { label: "Closed", cls: "bg-destructive/15 text-destructive" };
    default:
      return { label: state, cls: "bg-muted text-muted-foreground" };
  }
}

// ---------------------------------------------------------------------------
// Changeset row
// ---------------------------------------------------------------------------

interface ChangesetRowProps {
  item: ChangesetItem;
  onClick: () => void;
}

export function ChangesetRow({ item, onClick }: ChangesetRowProps) {
  const { pr, session } = item;
  const chip = prStateChip(pr.state);
  // Age reflects the same recency proxy the /api/changesets sort + the page's
  // client-side sort use (changesetRecencyIso → lastActivityAt ?? createdAt).
  // mt#1920 R1/R2.
  const recencyIso = changesetRecencyIso(session);
  const age = recencyIso ? relativeTime(recencyIso) : "—";
  const prNumber = pr.number != null ? `#${pr.number}` : "—";
  // Shared with the changeset DETAIL header (mt#3096) so the two cannot drift:
  // the detail page used to render a literal "(no title)" where this row
  // already fell back to the task title.
  const title = changesetDisplayTitle(pr, session);
  const taskId = session.taskId;
  const branch = pr.headBranch ?? session.branch ?? "—";
  const approvedText = pr.approved == null ? "—" : pr.approved ? "Approved" : "Pending";
  const approvedCls =
    pr.approved == null
      ? "text-muted-foreground"
      : pr.approved
        ? "text-green-400"
        : "text-muted-foreground";

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md",
        "border border-border bg-card hover:bg-muted/40 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      {/* PR number */}
      <span className="text-xs font-mono text-muted-foreground flex-shrink-0 w-12 text-right tabular-nums">
        {prNumber}
      </span>

      {/* State chip */}
      <span
        className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${chip.cls}`}
      >
        {chip.label}
      </span>

      {/* Title + task id */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{title}</p>
        {(taskId || branch) && (
          <div className="flex items-center gap-2 mt-0.5">
            {taskId && (
              <Link
                to={`/tasks/${encodeURIComponent(taskId)}`}
                onClick={(e) => e.stopPropagation()}
                className="text-xs font-mono text-muted-foreground hover:text-foreground hover:underline transition-colors"
              >
                {taskId}
              </Link>
            )}
            {branch && (
              <span className="text-xs text-muted-foreground truncate max-w-[160px]">{branch}</span>
            )}
          </div>
        )}
      </div>

      {/* Reviewer-bot state — reads record.prApproved (wired); degrades to "—"
          only when that field is null (no review yet). */}
      <span
        className={`text-xs flex-shrink-0 hidden sm:block w-16 text-right tabular-nums ${approvedCls}`}
        aria-label={`Review: ${approvedText}`}
      >
        {approvedText}
      </span>

      {/* CI state — degrades to "—" (no CI data path yet) */}
      <span
        className="text-xs text-muted-foreground flex-shrink-0 hidden md:block w-8 text-right"
        aria-label="CI: unknown"
      >
        —
      </span>

      {/* Age */}
      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums w-16 text-right">
        {age}
      </span>

      {/* Secondary GitHub link-out — not the primary action */}
      {pr.url && (
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View on GitHub"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex-shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
          )}
        >
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
        </a>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Changesets list
// ---------------------------------------------------------------------------

interface ChangesetsProps {
  items: ChangesetItem[];
  onRowClick: (item: ChangesetItem) => void;
}

export function Changesets({ items, onRowClick }: ChangesetsProps) {
  if (items.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm font-medium text-foreground">No active changesets</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Open or draft PRs linked to Minsky sessions will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {items.map((item) => {
        const key = item.pr.number != null ? `pr-${item.pr.number}` : item.session.sessionId;
        return (
          <ChangesetRow
            key={key}
            item={item}
            onClick={() => onRowClick(item)}
          />
        );
      })}
    </div>
  );
}