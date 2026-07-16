/**
 * RunDetail (mt#2768 — "Tabbed run detail: Overview/Conversation/Context tabs
 * on one shared detail surface").
 *
 * Design doc: https://app.notion.com/p/39c937f03cb481d4aa32c9b2891fa100
 * (parent mt#2766). ONE component addressable by BOTH existing entity keys:
 *
 *   - `keySpace="workspace"` — `/agents/:workspaceSessionId` (mt#1919's
 *     drill-down). Overview is the landing tab; Conversation/Context resolve
 *     via the workspace->conversation join (`/api/agents/:id`'s
 *     `conversations` field).
 *   - `keySpace="conversation"` — `/conversation/:agentSessionId` (mt#2398 /
 *     mt#2374). Conversation is the landing tab; Overview resolves via the
 *     REVERSE join (`/api/conversation/:id/overview`) when a workspace
 *     exists, else collapses to conversation metadata (cwd, harness,
 *     started, turn count).
 *
 * Tab state is URL-addressable: `/agents/:id` (Overview, default) ↔
 * `/agents/:id/conversation` ↔ `/agents/:id/context`; symmetrically
 * `/conversation/:id` (Conversation, default) ↔ `/conversation/:id/overview`
 * ↔ `/conversation/:id/context`. Deep-linking to a non-default tab and
 * hard-refreshing both work — the tab is derived from the URL, not local
 * component state (mirrors `pages/TasksLayout.tsx`'s URL-driven tab pattern).
 *
 * The page wrappers (`pages/WorkspaceDetailPage.tsx`,
 * `pages/ConversationPage.tsx`) keep their own page-level chrome (breadcrumb
 * vs. label header) and mount `<RunDetail key={id} .../>` for the tabbed
 * body below it — remounting on `id` change resets internal tab-adjacent
 * state (e.g. the multi-conversation switcher selection) cleanly.
 */
import { useState } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { MetaItem } from "../components/MetaItem";
import { ConversationView } from "./ConversationView";
import { ContextBlockView } from "./ContextBlockView";
import { ConversationOverviewPanel } from "./ConversationOverviewPanel";
import type { WorkspaceId, ConversationId } from "@minsky/domain/ids";

// ---------------------------------------------------------------------------
// Types — mirror the backend payloads (session-detail.ts / workspace-overview.ts)
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

export interface WorkspaceOverviewFields {
  session: {
    sessionId: string;
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
}

/** A single conversation candidate — drives the multi-conversation switcher. */
export interface ConversationCandidate {
  agentSessionId: string;
  startedAt: string | null;
}

export interface WorkspaceDetailPayload extends WorkspaceOverviewFields {
  conversation: { agentSessionId: string } | null;
  conversations: ConversationCandidate[];
  /** App-started driven session bound to this workspace (mt#2752) — drives
   *  the "open live drive view" banner. Absent/null for observe-only rows. */
  driven?: { sessionId: string; status: string } | null;
}

export interface ConversationOverviewPayload {
  agentSessionId: string;
  conversationMeta: {
    cwd: string | null;
    harness: string;
    startedAt: string | null;
    endedAt: string | null;
    turnCount: number;
    /** Regex-extracted `mt#NNNN` task refs found in the transcript (mt#1329 metadata-extractor). */
    relatedTaskIds: string[];
    /** Regex-extracted PR numbers (as strings) found in the transcript (mt#1329 metadata-extractor). */
    relatedPrNumbers: string[];
    /**
     * Last-seen JSONL entry timestamp (`lastIngestedJsonlTimestamp`) — the
     * duration fallback for an in-progress conversation with no `endedAt` yet
     * (mt#2792). Null when the conversation has never been incrementally
     * re-ingested (e.g. ingested once, at completion — `endedAt` covers that case).
     */
    lastActivityAt: string | null;
  };
  workspace: WorkspaceOverviewFields | null;
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchWorkspaceDetail(sessionId: WorkspaceId): Promise<WorkspaceDetailPayload> {
  const encoded = encodeURIComponent(sessionId);
  const res = await fetch(`/api/agents/${encoded}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<WorkspaceDetailPayload>;
}

async function fetchConversationOverview(
  agentSessionId: ConversationId
): Promise<ConversationOverviewPayload> {
  const encoded = encodeURIComponent(agentSessionId);
  const res = await fetch(`/api/conversation/${encoded}/overview`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<ConversationOverviewPayload>;
}

// ---------------------------------------------------------------------------
// Tab <-> URL mapping
// ---------------------------------------------------------------------------

export type RunTab = "overview" | "conversation" | "context";
export type RunKeySpace = "workspace" | "conversation";

// Exported for direct unit testing (RunDetail.tabs.test.ts) — pure, no
// React/router dependency, so a full component render isn't needed to pin
// the URL<->tab contract.

export function basePathFor(keySpace: RunKeySpace, id: string): string {
  return keySpace === "workspace"
    ? `/agents/${encodeURIComponent(id)}`
    : `/conversation/${encodeURIComponent(id)}`;
}

export function defaultTabFor(keySpace: RunKeySpace): RunTab {
  return keySpace === "workspace" ? "overview" : "conversation";
}

export function tabFromPathname(pathname: string, base: string, keySpace: RunKeySpace): RunTab {
  const suffix = pathname === base ? "" : pathname.slice(base.length).replace(/^\//, "");
  if (keySpace === "workspace") {
    if (suffix === "conversation") return "conversation";
    if (suffix === "context") return "context";
    return "overview";
  }
  if (suffix === "overview") return "overview";
  if (suffix === "context") return "context";
  return "conversation";
}

export function pathForTab(base: string, keySpace: RunKeySpace, tab: RunTab): string {
  return tab === defaultTabFor(keySpace) ? base : `${base}/${tab}`;
}

// ---------------------------------------------------------------------------
// Presentation helpers (shared Overview rendering)
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

function WorkspaceOverviewBody({ fields }: { fields: WorkspaceOverviewFields }) {
  const { session, commits, pr } = fields;
  return (
    <div className="flex flex-col gap-4">
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

      <section aria-label="Recent commits">
        <h3 className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
          Commits{session.commitCount != null ? ` (${session.commitCount} total)` : ""}
        </h3>
        {commits.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {session.lastCommitMessage ? `Last: ${session.lastCommitMessage}` : "No session commits yet"}
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
                <span className="truncate">{c.subject}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ConversationMetaBody({ meta }: { meta: ConversationOverviewPayload["conversationMeta"] }) {
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
      <MetaItem label="Harness">{meta.harness}</MetaItem>
      <MetaItem label="Cwd">
        <span className="font-mono text-xs">{meta.cwd ?? "—"}</span>
      </MetaItem>
      <MetaItem label="Started">{formatTimestamp(meta.startedAt)}</MetaItem>
      <MetaItem label="Turns">{meta.turnCount}</MetaItem>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Overview tab — branches on keySpace
// ---------------------------------------------------------------------------

function OverviewTab({
  keySpace,
  id,
  workspaceData,
  workspaceQuery,
  conversationData,
  conversationQuery,
}: {
  keySpace: RunKeySpace;
  /** Conversation-keyed arrivals only — the harness agentSessionId (mt#2792 enrichment panel). */
  id: string;
  workspaceData: WorkspaceDetailPayload | undefined;
  workspaceQuery: { isPending: boolean; isError: boolean; error: Error | null };
  conversationData: ConversationOverviewPayload | undefined;
  conversationQuery: { isPending: boolean; isError: boolean; error: Error | null };
}) {
  if (keySpace === "workspace") {
    if (workspaceQuery.isPending) return <LoadingState message="Loading workspace…" />;
    if (workspaceQuery.isError) return <ErrorState error={workspaceQuery.error ?? undefined} />;
    if (!workspaceData) return <p className="text-sm text-muted-foreground">No workspace data.</p>;
    return <WorkspaceOverviewBody fields={workspaceData} />;
  }

  // Conversation-keyed: reverse-join resolved workspace, or conversation metadata fallback —
  // either way, the mt#2792 enrichment panel (related task/PR, duration, tool activity,
  // last-message snippet) renders below the existing body.
  if (conversationQuery.isPending) return <LoadingState message="Loading overview…" />;
  if (conversationQuery.isError) return <ErrorState error={conversationQuery.error ?? undefined} />;
  if (!conversationData) return <p className="text-sm text-muted-foreground">No overview data.</p>;
  return (
    <div className="flex flex-col gap-4">
      {conversationData.workspace ? (
        <WorkspaceOverviewBody fields={conversationData.workspace} />
      ) : (
        <ConversationMetaBody meta={conversationData.conversationMeta} />
      )}
      <ConversationOverviewPanel
        agentSessionId={id as ConversationId}
        conversationMeta={conversationData.conversationMeta}
        workspace={conversationData.workspace}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface RunDetailProps {
  /** WorkspaceId (keySpace="workspace") or ConversationId (keySpace="conversation"). */
  id: string;
  keySpace: RunKeySpace;
  /** Forwarded to the Conversation tab's ConversationView (mt#2769 tab hygiene). */
  onConversationNotFound?: () => void;
}

export function RunDetail({ id, keySpace, onConversationNotFound }: RunDetailProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const base = basePathFor(keySpace, id);
  const tab = tabFromPathname(pathname, base, keySpace);

  const workspaceQuery = useQuery<WorkspaceDetailPayload, Error>({
    queryKey: ["workspace-detail", id],
    queryFn: () => fetchWorkspaceDetail(id as WorkspaceId),
    staleTime: 30_000,
    retry: 1,
    enabled: keySpace === "workspace",
  });

  const conversationOverviewQuery = useQuery<ConversationOverviewPayload, Error>({
    queryKey: ["conversation-overview", id],
    queryFn: () => fetchConversationOverview(id as ConversationId),
    staleTime: 30_000,
    retry: 1,
    enabled: keySpace === "conversation",
  });

  // Conversation candidates driving the multi-conversation switcher (mt#2768
  // Behavior: "Multi-conversation workspaces"). Conversation-keyed arrivals
  // always have exactly one candidate — the id itself, known synchronously.
  const conversationCandidates: ConversationCandidate[] =
    keySpace === "workspace"
      ? (workspaceQuery.data?.conversations ?? [])
      : [{ agentSessionId: id, startedAt: conversationOverviewQuery.data?.conversationMeta.startedAt ?? null }];

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const activeConversationId: string | null =
    keySpace === "conversation" ? id : (selectedConversationId ?? conversationCandidates[0]?.agentSessionId ?? null);

  function handleTabChange(value: string) {
    navigate(pathForTab(base, keySpace, value as RunTab));
  }

  // mt#2752 — an app-started driven session bound to this workspace gets a
  // banner linking to the input-capable drive view (/driven/:id). This is
  // how a workspace deeplink (minsky://session/<id> -> /agents/:id) reaches
  // the driven-session view without a new minsky:// URI type (spec SC5;
  // ADR-022 pins the URI type set).
  const driven = keySpace === "workspace" ? (workspaceQuery.data?.driven ?? null) : null;
  const drivenActive = driven != null && (driven.status === "running" || driven.status === "spawned");

  return (
    <div className="flex flex-col gap-4">
      {driven && (
        <Link
          to={`/driven/${encodeURIComponent(driven.sessionId)}`}
          className={`flex items-center gap-2 rounded border px-3 py-2 text-sm transition-colors ${
            drivenActive
              ? "border-amber-500/40 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"
              : "border-border bg-muted/40 text-muted-foreground hover:bg-accent/40"
          }`}
          aria-label={`Open driven session (${driven.status})`}
        >
          {drivenActive && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
          )}
          {drivenActive
            ? "Driven session live — open the drive view to interact"
            : `Driven session ${driven.status} — open the drive view`}
        </Link>
      )}
      <div className="border-b border-border/60">
        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList className="h-8 gap-0.5 bg-transparent p-0 border-0">
            {(["overview", "conversation", "context"] as const).map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="h-8 px-3 text-xs rounded-none border-b-2 border-transparent capitalize
                  data-[state=active]:border-primary data-[state=active]:bg-transparent
                  data-[state=active]:text-foreground data-[state=active]:shadow-none"
              >
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {tab === "overview" && (
        <OverviewTab
          keySpace={keySpace}
          id={id}
          workspaceData={workspaceQuery.data}
          workspaceQuery={workspaceQuery}
          conversationData={conversationOverviewQuery.data}
          conversationQuery={conversationOverviewQuery}
        />
      )}

      {tab === "conversation" && (
        <div className="flex flex-col gap-2">
          {keySpace === "workspace" && conversationCandidates.length > 1 && (
            <label className="text-xs text-muted-foreground flex items-center gap-2">
              Conversation
              <select
                className="text-sm bg-background border border-input rounded px-2 py-1"
                value={activeConversationId ?? ""}
                onChange={(e) => setSelectedConversationId(e.target.value || null)}
              >
                {conversationCandidates.map((c) => (
                  <option key={c.agentSessionId} value={c.agentSessionId}>
                    {c.agentSessionId}
                  </option>
                ))}
              </select>
            </label>
          )}
          {keySpace === "workspace" && workspaceQuery.isPending ? (
            <LoadingState message="Loading conversation…" />
          ) : activeConversationId ? (
            <ConversationView
              sessionId={activeConversationId as ConversationId}
              liveByConversationId
              onNotFound={onConversationNotFound}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No conversation linked to this workspace yet.
            </p>
          )}
        </div>
      )}

      {tab === "context" &&
        (keySpace === "workspace" && workspaceQuery.isPending ? (
          <LoadingState message="Loading context…" />
        ) : activeConversationId ? (
          <ContextBlockView agentSessionId={activeConversationId as ConversationId} />
        ) : (
          <p className="text-sm text-muted-foreground">No conversation to inspect yet.</p>
        ))}
    </div>
  );
}
