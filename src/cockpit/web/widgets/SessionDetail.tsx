/**
 * SessionDetail widget frontend (mt#1919)
 *
 * Self-fetching via TanStack Query. Renders a single WORKSPACE session's
 * detail view: meta header (status, liveness, branch, agent), linked task,
 * conversation link (when the workspace resolves to an ingested transcript),
 * recent commits, and PR state. Read-only; session-action affordances are
 * out of scope for v0.
 *
 * Keyed by the Minsky workspace sessionId — NOT the harness agentSessionId
 * that /session/:id (ConversationView) takes. The `conversation` field of the
 * payload carries the bridge between the two id-spaces.
 */
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { shortenId } from "../lib/format";
import type { WorkspaceId, ConversationId } from "@minsky/domain/ids";

// ---------------------------------------------------------------------------
// Types — mirrors the /api/agents/:id response shape (src/cockpit/session-detail.ts)
// ---------------------------------------------------------------------------

export interface SessionCommitRef {
  hash: string;
  shortHash: string;
  date: string | null;
  subject: string;
  url: string | null;
}

export interface SessionPrRef {
  number: number | null;
  url: string | null;
  state: string;
  title: string | null;
  headBranch: string | null;
  approved: boolean | null;
}

export interface SessionDetailPayload {
  session: {
    sessionId: WorkspaceId;
    taskId: string | null;
    taskTitle: string | null;
    status: string | null;
    liveness: "healthy" | "idle" | "stale" | "orphaned";
    agentId: string | null;
    branch: string | null;
    repoName: string | null;
    repoUrl: string | null;
    createdAt: string | null;
    lastActivityAt: string | null;
    lastCommitHash: string | null;
    lastCommitMessage: string | null;
    commitCount: number | null;
  };
  commits: SessionCommitRef[];
  pr: SessionPrRef | null;
  conversation: { agentSessionId: ConversationId } | null;
}

const LIVENESS_VALUES = ["healthy", "idle", "stale", "orphaned"] as const;

function isSessionDetailPayload(v: unknown): v is SessionDetailPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<SessionDetailPayload>;
  if (typeof p.session !== "object" || p.session === null) return false;
  if (typeof p.session.sessionId !== "string") return false;
  if (!LIVENESS_VALUES.includes(p.session.liveness as (typeof LIVENESS_VALUES)[number])) {
    return false;
  }
  if (!Array.isArray(p.commits)) return false;
  if (p.pr !== null && typeof p.pr !== "object") return false;
  if (
    p.conversation !== null &&
    (typeof p.conversation !== "object" ||
      typeof (p.conversation as { agentSessionId?: unknown }).agentSessionId !== "string")
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchSessionDetail(sessionId: WorkspaceId): Promise<SessionDetailPayload> {
  const encoded = encodeURIComponent(sessionId);
  const res = await fetch(`/api/agents/${encoded}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<SessionDetailPayload>;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function livenessDotClass(liveness: string): string {
  switch (liveness) {
    case "healthy":
      return "bg-emerald-400";
    case "idle":
      return "bg-amber-400";
    case "stale":
      return "bg-slate-500";
    case "orphaned":
    default:
      return "bg-red-400";
  }
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString();
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground uppercase tracking-wide">{label}</dt>
      <dd className="text-sm truncate">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function SessionDetailBody({
  sessionId,
  query,
}: {
  sessionId: WorkspaceId;
  query: UseQueryResult<SessionDetailPayload, Error>;
}) {
  if (query.isPending) {
    return <LoadingState message={`Loading session ${sessionId}…`} />;
  }

  if (query.isError) {
    return <ErrorState error={query.error} />;
  }

  const data = query.data;
  if (!isSessionDetailPayload(data)) {
    return <p className="text-sm text-muted-foreground">Malformed session payload.</p>;
  }

  const { session, commits, pr, conversation } = data;

  return (
    <div className="flex flex-col gap-4">
      {/* Meta grid */}
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
        <MetaItem label="Liveness">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${livenessDotClass(session.liveness)}`}
            />
            {session.liveness}
          </span>
        </MetaItem>
        <MetaItem label="Status">{session.status ?? "—"}</MetaItem>
        <MetaItem label="Branch">
          <span className="font-mono text-xs">{session.branch ?? "—"}</span>
        </MetaItem>
        <MetaItem label="Agent">
          <span className="font-mono text-xs">{session.agentId ?? "—"}</span>
        </MetaItem>
        <MetaItem label="Created">{formatTimestamp(session.createdAt)}</MetaItem>
        <MetaItem label="Last activity">{formatTimestamp(session.lastActivityAt)}</MetaItem>
      </dl>

      {/* Linked task */}
      <section aria-label="Linked task">
        <h3 className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Task</h3>
        {session.taskId ? (
          <Link
            to={`/tasks/${encodeURIComponent(session.taskId)}`}
            className="text-sm text-primary hover:underline"
          >
            <span className="font-mono">{session.taskId}</span>
            {session.taskTitle ? ` — ${session.taskTitle}` : ""}
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">No linked task</p>
        )}
      </section>

      {/* Conversation bridge (workspace → transcript resolution, mt#2420 deferral) */}
      {conversation && (
        <section aria-label="Conversation">
          <Link
            to={`/session/${encodeURIComponent(conversation.agentSessionId)}`}
            className="text-sm text-primary hover:underline"
          >
            View conversation →
          </Link>
        </section>
      )}

      {/* PR state */}
      <section aria-label="Pull request">
        <h3 className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Pull request</h3>
        {pr ? (
          <div className="text-sm flex items-center gap-2 flex-wrap">
            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-xs">
              {pr.state}
              {pr.approved ? " · approved" : ""}
            </span>
            {pr.url ? (
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {pr.number != null ? `#${pr.number}` : pr.headBranch}
                {pr.title ? ` — ${pr.title}` : ""}
              </a>
            ) : (
              <span className="font-mono text-xs">{pr.headBranch ?? "—"}</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No PR</p>
        )}
      </section>

      {/* Recent commits */}
      <section aria-label="Recent commits">
        <h3 className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
          Commits{session.commitCount != null ? ` (${session.commitCount} total)` : ""}
        </h3>
        {commits.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {session.lastCommitMessage
              ? `Last: ${session.lastCommitMessage}`
              : "No commits recorded"}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {commits.map((c) => (
              <li key={c.hash} className="text-sm flex items-baseline gap-2 min-w-0">
                {c.url ? (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-primary hover:underline flex-shrink-0"
                  >
                    {c.shortHash}
                  </a>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground flex-shrink-0">
                    {c.shortHash}
                  </span>
                )}
                {/* Plain text (not <Prose>): truncated single-line commit subject — block Markdown breaks layout. mt#2556 */}
                <span className="truncate">{c.subject}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main widget export — self-fetching via TanStack Query (mt#2373 seam)
// ---------------------------------------------------------------------------

interface SessionDetailProps {
  /** Minsky workspace sessionId (NOT the harness agentSessionId). */
  sessionId: WorkspaceId;
  /** Render-context variant; defaults to the full-page card frame. */
  variant?: WidgetVariant;
}

export function SessionDetail({ sessionId, variant = "card" }: SessionDetailProps) {
  const query = useQuery<SessionDetailPayload, Error>({
    queryKey: ["session-detail", sessionId],
    queryFn: () => fetchSessionDetail(sessionId),
    staleTime: 30_000,
    retry: 1,
  });

  // Dynamic title: branch on success (the human-meaningful name, matching the
  // Agents list's primary-label precedence), sessionId prefix otherwise.
  const shortId = shortenId(sessionId);
  const title =
    query.data && isSessionDetailPayload(query.data)
      ? (query.data.session.branch ?? shortId)
      : shortId;

  return (
    <WidgetShell variant={variant} title={title}>
      <SessionDetailBody sessionId={sessionId} query={query} />
    </WidgetShell>
  );
}