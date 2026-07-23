/**
 * ChangesetDetail widget (mt#2535, re-sourced by mt#3096).
 *
 * Detail body for a changeset/PR, rendered inside ChangesetDetailPage.
 * Follows the widget split convention: ChangesetDetailPage owns routing +
 * data fetching; ChangesetDetail owns the visual presentation. Sibling of
 * AskDetail / MemoryDetail / SessionDetail in the widgets/ convention.
 *
 * Data contract: the `changeset` prop is the full payload returned by
 * GET /api/changeset/:id. `pr` is sourced from the LIVE PR when the forge is
 * reachable and falls back to the session-record snapshot otherwise; `detail`
 * carries the live-only fields (body, diffstat, merge metadata) and is null on
 * the fallback path; `session` is null for a PR with no (or a cleaned-up)
 * Minsky session.
 *
 * What this page is FOR (mt#3096): orienting on a change and deciding what it
 * needs — not restating GitHub. It leads with identity + lifecycle state, layers
 * the Minsky-specific overlay GitHub cannot show (linked task + status, the
 * workspace that produced it), and makes the break-out to GitHub a PRIMARY
 * affordance rather than a buried footer link, because the diff itself lives
 * there and is deliberately not rebuilt here.
 *
 * Extension point (mt#3097 — reviewer lifecycle + CI checks + inline merge):
 * the "needs-you" strip and the act-here merge affordance land there.
 */
import { Link } from "react-router-dom";
import { ExternalLink, GitCommit, GitMerge, Clock, User } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Prose } from "../components/Prose";
import { useEntityIndex } from "../lib/use-entity-index";
import { relativeTime } from "../lib/format";
import {
  changesetDisplayTitle,
  type SessionPrRef,
  type SessionDetailMeta,
  type SessionCommitRef,
  type ChangesetLiveDetail,
} from "../../session-detail";

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface ChangesetDetailPayload {
  pr: SessionPrRef;
  /** Null when no Minsky session matches this PR (e.g. merged + cleaned up). */
  session: SessionDetailMeta | null;
  commits: SessionCommitRef[];
  /** Live-PR-only fields; null when the endpoint degraded to the snapshot. */
  detail: ChangesetLiveDetail | null;
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
// Diffstat — omitted entirely when the forge didn't supply counts, so a
// degraded fetch never renders as a confident "+0 −0".
// ---------------------------------------------------------------------------

function DiffStat({ detail }: { detail: ChangesetLiveDetail | null }) {
  if (!detail || detail.additions === null || detail.deletions === null) return null;
  const files = detail.changedFiles;
  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground">
      <span className="text-foreground">+{detail.additions}</span>{" "}
      <span>&minus;{detail.deletions}</span>
      {files !== null && ` · ${files} file${files === 1 ? "" : "s"}`}
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
// Section heading
// ---------------------------------------------------------------------------

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="text-xs font-medium uppercase tracking-widest text-muted-foreground mb-2"
    >
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChangesetDetail({ changeset }: { changeset: ChangesetDetailPayload }) {
  const { pr, session, commits, detail } = changeset;
  const entityIndex = useEntityIndex();

  // Shared with the changesets LIST row so the two cannot drift — the
  // originating bug was the detail page rendering a literal "(no title)"
  // while the row it was reached from already fell back to the task title.
  const prTitle = changesetDisplayTitle(pr, session);
  const prNumber = pr.number != null ? `#${pr.number}` : null;

  return (
    <div className="flex flex-col gap-4">
      {/* PR header card */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base font-semibold leading-snug">
                {prNumber && (
                  <span className="font-mono text-muted-foreground mr-2 text-sm">{prNumber}</span>
                )}
                {prTitle}
              </CardTitle>

              {/* Lifecycle state line */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <PrStateChip state={pr.state} />
                <ApprovalChip approved={pr.approved} />
                {detail?.author && (
                  <span className="text-xs text-muted-foreground">
                    by <span className="font-mono text-foreground">{detail.author}</span>
                  </span>
                )}
                <DiffStat detail={detail} />
              </div>

              {detail?.mergedAt && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Merged
                  {detail.mergedBy && (
                    <>
                      {" by "}
                      <span className="font-mono text-foreground">{detail.mergedBy}</span>
                    </>
                  )}
                  {" · "}
                  {relativeTime(detail.mergedAt)}
                </p>
              )}
            </div>

            {/* Primary break-out. The diff itself lives on GitHub and is
                deliberately not rebuilt here, so reaching it must be immediate. */}
            {pr.url && (
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                Open on GitHub
              </a>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            {/* Linked task — the Minsky overlay GitHub cannot show */}
            {session?.taskId && (
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
            {(pr.headBranch ?? session?.branch) && (
              <>
                <dt className="text-muted-foreground">Branch</dt>
                <dd className="font-mono text-xs text-foreground truncate">
                  {pr.headBranch ?? session?.branch}
                </dd>
              </>
            )}

            {/* Age / timestamps */}
            {session?.createdAt && (
              <>
                <dt className="flex items-center gap-1 text-muted-foreground">
                  <Clock aria-hidden className="h-3 w-3" />
                  <span>Opened</span>
                </dt>
                <dd className="text-foreground">{relativeTime(session.createdAt)}</dd>
              </>
            )}
            {session?.lastActivityAt && (
              <>
                <dt className="text-muted-foreground">Last activity</dt>
                <dd className="text-foreground">{relativeTime(session.lastActivityAt)}</dd>
              </>
            )}

            {/* Agent / author */}
            {session?.agentId && (
              <>
                <dt className="flex items-center gap-1 text-muted-foreground">
                  <User aria-hidden className="h-3 w-3" />
                  <span>Agent</span>
                </dt>
                <dd className="font-mono text-xs text-foreground truncate">{session.agentId}</dd>
              </>
            )}
          </dl>

          {/* Honest degradation: say so rather than letting a snapshot render
              as if it were live (a stale title is indistinguishable otherwise). */}
          {!detail && (
            <p className="mt-3 text-xs text-muted-foreground/70">
              Live pull-request data unavailable — showing the cached session snapshot.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Description — the single best "what is this change" artifact, and
          entirely absent from this page before mt#3096. */}
      {detail?.body && (
        <section aria-labelledby="description-heading">
          <SectionHeading id="description-heading">Description</SectionHeading>
          <Card>
            <CardContent className="py-3">
              <Prose entityIndex={entityIndex}>{detail.body}</Prose>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Review — extension point for mt#3097 (reviewer lifecycle + CI) */}
      {pr.approved !== null && (
        <section aria-labelledby="review-heading">
          <SectionHeading id="review-heading">Review</SectionHeading>
          <Card>
            <CardContent className="py-3">
              <div className="flex items-center gap-2">
                <GitMerge aria-hidden className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-foreground">
                  {pr.approved ? "Approved — ready to merge" : "Awaiting reviewer approval"}
                </span>
                {detail?.reviewCount != null && detail.reviewCount > 0 && (
                  <span className="text-xs text-muted-foreground">
                    · {detail.reviewCount} review{detail.reviewCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Commits section */}
      {commits.length > 0 && (
        <section aria-labelledby="commits-heading">
          <SectionHeading id="commits-heading">Recent commits</SectionHeading>
          <Card>
            <CardContent className="py-2 px-3">
              {commits.map((c) => (
                <CommitRow key={c.hash} commit={c} />
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}
