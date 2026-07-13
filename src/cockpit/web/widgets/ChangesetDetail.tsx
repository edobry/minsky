/**
 * ChangesetDetail widget (mt#2535).
 *
 * Detail body for a changeset/PR, rendered inside ChangesetDetailPage.
 * Follows the widget split convention: ChangesetDetailPage owns routing +
 * data fetching; ChangesetDetail owns the visual presentation. Sibling of
 * AskDetail / MemoryDetail / SessionDetail in the widgets/ convention.
 *
 * Data contract: the `changeset` prop is the full payload returned by
 * GET /api/changeset/:id — a SessionPrRef + SessionDetailMeta + commits.
 * The page component fetches this and passes it down.
 *
 * Extension point (mt#2076/mt#2435 — reviewer lifecycle + CI checks):
 * when those land, add reviewer-state data to the ChangesetDetailPayload
 * and extend the "Review & CI" section below.
 */
import { Link } from "react-router-dom";
import { ExternalLink, GitCommit, GitMerge, Clock, User } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { relativeTime } from "../lib/format";
import type { SessionPrRef, SessionDetailMeta, SessionCommitRef } from "../../session-detail";

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface ChangesetDetailPayload {
  pr: SessionPrRef;
  session: SessionDetailMeta;
  commits: SessionCommitRef[];
}

// ---------------------------------------------------------------------------
// PR state chip (inline span — no badge component available yet)
// ---------------------------------------------------------------------------

type PrState = "open" | "closed" | "merged" | "draft" | "unknown" | string;

function stateChipClass(state: PrState): string {
  switch (state) {
    case "open":
      return "bg-primary/15 text-primary border-primary/30";
    case "merged":
      return "bg-secondary/50 text-foreground border-border";
    case "closed":
      return "bg-destructive/15 text-destructive border-destructive/30";
    case "draft":
      return "bg-muted text-muted-foreground border-border";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function PrStateChip({ state }: { state: PrState }) {
  const label = state.charAt(0).toUpperCase() + state.slice(1);
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border font-mono text-xs uppercase tracking-wide ${stateChipClass(state)}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Approval chip
// ---------------------------------------------------------------------------

function ApprovalChip({ approved }: { approved: boolean | null }) {
  if (approved === null) return null;
  return approved ? (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-border bg-muted text-foreground text-xs">
      Approved
    </span>
  ) : (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-border bg-transparent text-muted-foreground text-xs">
      Pending review
    </span>
  );
}

// ---------------------------------------------------------------------------
// Commit row
// ---------------------------------------------------------------------------

function CommitRow({ commit }: { commit: SessionCommitRef }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-border/50 last:border-0">
      <GitCommit aria-hidden className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {commit.url ? (
            <a
              href={commit.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-primary hover:underline flex-shrink-0"
              aria-label={`Commit ${commit.shortHash}`}
            >
              {commit.shortHash}
            </a>
          ) : (
            <span className="font-mono text-xs text-muted-foreground flex-shrink-0">
              {commit.shortHash}
            </span>
          )}
          {commit.date && (
            <span className="text-xs text-muted-foreground flex-shrink-0">
              {relativeTime(commit.date)}
            </span>
          )}
        </div>
        <p className="text-sm text-foreground truncate mt-0.5" title={commit.subject}>
          {commit.subject}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChangesetDetail({ changeset }: { changeset: ChangesetDetailPayload }) {
  const { pr, session, commits } = changeset;

  const prTitle = pr.title ?? "(no title)";
  const prNumber = pr.number != null ? `#${pr.number}` : null;

  return (
    <div className="flex flex-col gap-4">
      {/* PR header card */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base font-semibold leading-snug">
              {prNumber && (
                <span className="font-mono text-muted-foreground mr-2 text-sm">{prNumber}</span>
              )}
              {prTitle}
            </CardTitle>
            <div className="flex items-center gap-2 flex-shrink-0">
              <PrStateChip state={pr.state} />
              <ApprovalChip approved={pr.approved} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            {/* Linked task */}
            {session.taskId && (
              <>
                <dt className="text-muted-foreground">Task</dt>
                <dd>
                  <Link
                    to={`/tasks/${encodeURIComponent(session.taskId)}`}
                    className="font-mono text-primary hover:underline"
                  >
                    {session.taskId}
                  </Link>
                  {session.taskTitle && (
                    <span className="ml-1.5 text-muted-foreground text-xs">
                      — {session.taskTitle}
                    </span>
                  )}
                </dd>
              </>
            )}

            {/* Head branch */}
            {(pr.headBranch ?? session.branch) && (
              <>
                <dt className="text-muted-foreground">Branch</dt>
                <dd className="font-mono text-xs text-foreground truncate">
                  {pr.headBranch ?? session.branch}
                </dd>
              </>
            )}

            {/* Age / timestamps */}
            {session.createdAt && (
              <>
                <dt className="flex items-center gap-1 text-muted-foreground">
                  <Clock aria-hidden className="h-3 w-3" />
                  <span>Opened</span>
                </dt>
                <dd className="text-foreground">{relativeTime(session.createdAt)}</dd>
              </>
            )}
            {session.lastActivityAt && (
              <>
                <dt className="text-muted-foreground">Last activity</dt>
                <dd className="text-foreground">{relativeTime(session.lastActivityAt)}</dd>
              </>
            )}

            {/* Agent / author */}
            {session.agentId && (
              <>
                <dt className="flex items-center gap-1 text-muted-foreground">
                  <User aria-hidden className="h-3 w-3" />
                  <span>Agent</span>
                </dt>
                <dd className="font-mono text-xs text-foreground truncate">{session.agentId}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Review & CI section — extension point for mt#2076/mt#2435 */}
      {/* TODO(mt#2076): replace stub with reviewer-state data once the
          reviewer-lifecycle endpoint lands. */}
      {pr.approved !== null && (
        <section aria-labelledby="review-heading">
          <h2
            id="review-heading"
            className="text-xs font-medium uppercase tracking-widest text-muted-foreground mb-2"
          >
            Review
          </h2>
          <Card>
            <CardContent className="py-3">
              <div className="flex items-center gap-2">
                <GitMerge aria-hidden className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-foreground">
                  {pr.approved ? "Approved — ready to merge" : "Awaiting reviewer approval"}
                </span>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Commits section */}
      {commits.length > 0 && (
        <section aria-labelledby="commits-heading">
          <h2
            id="commits-heading"
            className="text-xs font-medium uppercase tracking-widest text-muted-foreground mb-2"
          >
            Recent commits
          </h2>
          <Card>
            <CardContent className="py-2 px-3">
              {commits.map((c) => (
                <CommitRow key={c.hash} commit={c} />
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      {/* External GitHub PR link — secondary affordance */}
      {pr.url && (
        <div className="flex justify-end">
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-label="View on GitHub"
          >
            <ExternalLink aria-hidden className="h-3.5 w-3.5" />
            View on GitHub
          </a>
        </div>
      )}
    </div>
  );
}
