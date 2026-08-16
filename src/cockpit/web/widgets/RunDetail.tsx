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
 * vs. label header) and pass it in through the `chrome` slot — mounting it as
 * a preceding SIBLING is what mt#3344 had to undo. The header and the tab strip
 * must pin together, and two independent `sticky top-0` elements at different
 * DOM depths overlap rather than stack; pinning the tab strip at a fixed
 * `top-[Npx]` is not viable either, because the header's height varies (the id
 * sub-line is conditional, the presence readout is one or two lines). One
 * sticky container holding both is the only shape that keeps them stacked
 * without measuring. Remounting on `id` change (`<RunDetail key={id} .../>`)
 * still resets internal tab-adjacent state (e.g. the multi-conversation
 * switcher selection) cleanly.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { MetaItem } from "../components/MetaItem";
import { ConversationView } from "./ConversationView";
import { ContextBlockView } from "./ContextBlockView";
import { ConversationOverviewPanel } from "./ConversationOverviewPanel";
import { SessionFilm } from "../components/session-film/SessionFilm";
import { livenessDotClass } from "../lib/liveness-colors";
import { formatLinkType } from "../lib/conversation-link-type";
import { relativeTime, shortenId } from "../lib/format";
import { parseTurnAddress } from "../lib/conversation-turn-address";
import type { WorkspaceId, ConversationId } from "@minsky/domain/ids";
import type { ConversationLinkSource } from "../../conversation-link-source";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

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
    /** Numeric `ws#N` short id (mt#2967) — null for legacy sessions pre-backfill. */
    shortId: string | null;
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
  /**
   * How the link was resolved (mt#3529) — the union is imported, not restated,
   * so a third provenance cannot land server-side while this copy goes stale.
   * Optional: conversation-keyed arrivals construct their single candidate
   * client-side, with no server round-trip to carry provenance.
   */
  source?: ConversationLinkSource;
  /**
   * Server-computed display label (mt#3691) — the same `computeConversationLabel`
   * precedence `ConversationOverviewPayload.label` carries, computed per
   * candidate so the switcher names conversations instead of listing uuids.
   *
   * Optional for two reasons, both of which the switcher handles by falling
   * back to a shortened id rather than a bare uuid: a conversation-keyed
   * arrival builds its single candidate client-side with no server round-trip,
   * and the server omits the field when the label lookup degraded.
   */
  label?: string;
  /**
   * `minsky_session_links.link_type` (mt#3691) — which of the five writer
   * classes stamped this link. Finer than `source`, which only separates
   * stamped from derived: this is what lets an operator tell the conversation
   * that CREATED the workspace from a subagent that worked in it.
   *
   * Null on a derived candidate (no link row exists), absent on a
   * client-constructed one. Rendered through `formatLinkType`; no chip renders
   * when it is missing.
   */
  linkType?: string | null;
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
  /**
   * Server-computed display label (mt#3343) — the same `computeConversationLabel`
   * precedence the run list uses (bound task title -> generated title ->
   * first-user-prompt snippet -> subagent descriptor -> timestamp·cwd·id).
   *
   * Computed server-side, not in the browser: `custom/no-node-import-in-cockpit-web`
   * bans value imports from `@minsky/domain` in this bundle, and tiers 1/3 need
   * DB joins the browser cannot make. Always a non-empty string — the precedence
   * function's tier-4 fallback covers the "nothing resolved" case.
   */
  label: string;
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

/**
 * Exported (mt#2967) so page-level chrome (`pages/WorkspaceDetailPage.tsx`'s
 * breadcrumb) can fetch the SAME workspace-detail payload — under the same
 * `["workspace-detail", id]` query key used below — to read `session.shortId`
 * for the `CopyId` `displayId` prop, without triggering a second network
 * request (TanStack Query dedupes identical keys under one QueryClient).
 * Mirrors `MemoryPage.tsx`'s displayId-fetch pattern (mt#2966).
 */
export async function fetchWorkspaceDetail(
  sessionId: WorkspaceId
): Promise<WorkspaceDetailPayload> {
  const encoded = encodeURIComponent(sessionId);
  const res = await fetch(`/api/agents/${encoded}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<WorkspaceDetailPayload>;
}

export async function fetchConversationOverview(
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

export type RunTab = "overview" | "conversation" | "context" | "film";
export type RunKeySpace = "workspace" | "conversation";

/**
 * The tab strip's order per keyspace, and the single source of truth for which
 * suffixes `tabFromPathname` accepts.
 *
 * The film is CONVERSATION-ONLY (mt#3468). mt#3461 registered it under both
 * keyspaces on the reasoning that every other tab is registered under both and
 * `activeConversationId` resolves in both — but consistency with an existing
 * duplication is not a justification. A film is a replay of a CONVERSATION;
 * addressing it through a workspace means "the film of whichever conversation
 * this workspace currently has selected," an indirection whose referent is
 * ambiguous and which no surface needs. A workspace reaches a film the honest
 * way: through the conversation it links to.
 *
 * "film" is last in the conversation set deliberately — it is the widest and
 * least-often-wanted view, so it sits after the three text surfaces.
 */
export const RUN_TABS_BY_KEYSPACE: Record<RunKeySpace, readonly RunTab[]> = {
  workspace: ["overview", "conversation", "context"],
  conversation: ["overview", "conversation", "context", "film"],
};

/** The tabs offered for `keySpace`, in strip order. */
export function runTabsFor(keySpace: RunKeySpace): readonly RunTab[] {
  return RUN_TABS_BY_KEYSPACE[keySpace];
}

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
  // "film" resolves ONLY in the conversation keyspace (mt#3468). A stale
  // /agents/:id/film falls through to the workspace default below rather than
  // resolving to a tab the strip no longer offers — which would render a film
  // with no way to navigate away from it.
  if (suffix === "film") return keySpace === "conversation" ? "film" : "overview";
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
            {session.lastCommitMessage
              ? `Last: ${session.lastCommitMessage}`
              : "No session commits yet"}
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

/**
 * The Overview tab's body, for both keyspaces.
 *
 * Exported (mt#4069) so a peek renders THIS rather than a compact restatement
 * of it. A peek shows the overview and stops there: `mem#742` assigns transcript
 * replay to deep investigation, which is not what a lateral-reference pane is
 * for — so the peek reuses this body while the tabbed `RunDetail` shell around
 * it, and the transcript it hosts, stay on the page.
 *
 * Takes already-fetched data plus each query's state rather than fetching, which
 * is what lets both hosts share it: `RunDetail` passes its own queries, and
 * `PeekBody`'s adapter runs the same queries under the same keys (TanStack
 * dedupes them, so peeking a run already on screen costs no second request).
 */
export function OverviewTab({
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
  /**
   * The conversation to FETCH, when it differs from the addressable `id`
   * (mt#3132). The unified conversation route accepts a driven actuator's
   * spawn-time local id as a permanently-valid alias, so `id` stays whatever
   * the URL said — tab links must keep resolving to the address the operator
   * actually used — while data is read under the harness conversation id the
   * alias resolves to.
   *
   * Defaults to `id`, which is every caller's case except that alias. Ignored
   * in the workspace keyspace, where `id` is a WorkspaceId and the
   * conversation is reached through the join instead.
   */
  resolvedConversationId?: string;
  /** Forwarded to the Conversation tab's ConversationView (mt#2769 tab hygiene). */
  onConversationNotFound?: () => void;
  /**
   * Page-level chrome (label header, breadcrumb) rendered INSIDE the pinned
   * container above the tab strip (mt#3344). Supplied by the page wrapper so
   * each host keeps its own chrome while sharing one pinned region.
   */
  chrome?: ReactNode;
  /**
   * Chrome keyed on the ACTIVE conversation, rendered inside the pinned region
   * below `chrome` (mt#3554). Separate from `chrome` because the host cannot
   * build it alone: which conversation is active is resolved HERE — from the
   * workspace->conversation join, then the switcher's selection — so the id has
   * to come back out. Not called when no conversation resolves, so a host
   * cannot accidentally render an empty presence chip for an unlinked
   * workspace.
   */
  renderActiveConversationChrome?: (conversationId: string) => ReactNode;
  /**
   * Content for the tail of the Conversation tab, after the transcript
   * (mt#3344) — where the live-activity readout belongs.
   *
   * A render prop rather than a plain node (mt#3554): `/agents/:id` needs the
   * same readout, and its host does NOT know the conversation id — it is
   * resolved here. Both hosts now go through this one slot; a static-node
   * variant kept alongside it would be a second mechanism for the same job,
   * and the copy the next change forgets.
   */
  renderActiveConversationTail?: (conversationId: string) => ReactNode;
}

export function RunDetail({
  id,
  keySpace,
  resolvedConversationId,
  onConversationNotFound,
  chrome,
  renderActiveConversationChrome,
  renderActiveConversationTail,
}: RunDetailProps) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const base = basePathFor(keySpace, id);
  const tab = tabFromPathname(pathname, base, keySpace);
  /**
   * A turn the URL asked to land on (mt#3791), resolved here because this is the
   * router-aware component — `ConversationView` is rendered by several callers
   * that have no router at all, so it takes the address as a prop instead.
   *
   * Deliberately NOT scoped to one keyspace: `/agents/:id/conversation` renders
   * the same thread as `/conversation/:id`, so an address works on both. (Per
   * mem#811's parity gate, a keyspace-exclusive prop would need a spec criterion
   * saying the exclusion is intended; there is no reason for one here.)
   */
  const turnTarget = useMemo(() => parseTurnAddress(search) ?? undefined, [search]);
  /**
   * Where a transcript row's "watch this moment" link goes (mt#3794) — the film
   * tab of THIS conversation, which `FilmMomentLink` appends the row's own
   * address to.
   *
   * Keyspace-scoped where `turnTarget` above deliberately is not, because the
   * film is: `RUN_TABS_BY_KEYSPACE` offers it only under `conversation`
   * (mt#3468). Under a workspace the same thread renders with no affordance
   * rather than a link to a tab that is not there.
   *
   * NOT additionally gated on the conversation having a film, which mt#3794's
   * spec originally required and was amended to drop. Reachability is answered
   * where the answer actually lives: the film resolves the address on arrival
   * and reports when it cannot, which covers a turn that produced no event and
   * an address stale after a re-ingest — cases no list-level flag could see.
   * The Film TAB three lines of JSX below is ungated for the same reason, so
   * hiding the row link would be an inconsistency rather than a protection.
   *
   * This comment used to carry a longer argument about `scrubGateOk` being
   * unreachable from this payload. That flag no longer exists: mt#3268 /
   * ADR-040 removed the credential-scrub gate from the film entirely, on the
   * decision that it binds where transcript bytes cross the trust boundary,
   * not on the operator's own authenticated read.
   */
  const filmPath =
    keySpace === "conversation" ? pathForTab(base, keySpace, "film") : undefined;
  // The addressable id builds paths; this one reads data. They coincide for
  // every caller except the unified route's local-id alias (mt#3132).
  const dataId = resolvedConversationId ?? id;

  const workspaceQuery = useQuery<WorkspaceDetailPayload, Error>({
    queryKey: ["workspace-detail", id],
    queryFn: () => fetchWorkspaceDetail(id as WorkspaceId),
    staleTime: 30_000,
    retry: 1,
    enabled: keySpace === "workspace",
  });

  const conversationOverviewQuery = useQuery<ConversationOverviewPayload, Error>({
    queryKey: ["conversation-overview", dataId],
    queryFn: () => fetchConversationOverview(dataId as ConversationId),
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
      : [
          {
            agentSessionId: dataId,
            startedAt: conversationOverviewQuery.data?.conversationMeta.startedAt ?? null,
          },
        ];

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const activeConversationId: string | null =
    keySpace === "conversation"
      ? dataId
      : (selectedConversationId ?? conversationCandidates[0]?.agentSessionId ?? null);

  function handleTabChange(value: string) {
    navigate(pathForTab(base, keySpace, value as RunTab));
  }

  // mt#2752 — an app-started driven session bound to this workspace gets a
  // banner linking to the input-capable drive view (/driven/:id). This is
  // how a workspace deeplink (minsky://session/<id> -> /agents/:id) reaches
  // the driven-session view without a new minsky:// URI type (spec SC5;
  // ADR-022 pins the URI type set).
  const driven = keySpace === "workspace" ? (workspaceQuery.data?.driven ?? null) : null;
  // `drivenActive` answers "is it working RIGHT NOW" — it drives the amber
  // pulse — which is deliberately NARROWER than the task page's *returnable*
  // predicate in `routes/tasks.ts` (`!isTerminalStatus`, which also admits
  // `reconnecting`). The two answer different questions and should not be
  // unified: a reconnecting session IS worth returning to (attaching resumes
  // it) but is not producing output, so pulsing amber for it would overstate
  // liveness. Flagged as an apparent inconsistency in PR #2448 R1; recorded
  // here so it reads as a choice rather than an oversight.
  const drivenActive =
    driven != null && (driven.status === "running" || driven.status === "spawned");

  return (
    <div className="flex flex-col gap-4">
      {/* The pinned run-detail chrome (mt#3344). `sticky top-0` resolves
          against Layout's `<main>` scroller — nothing between here and it
          clips overflow or establishes a containing block. The negative
          margins bleed over the page wrapper's `p-4` so transcript text cannot
          scroll through the padding gap above the bar, and the background must
          stay opaque for the same reason. */}
      <div
        className="sticky top-0 z-20 -mx-4 -mt-4 flex flex-col gap-2 border-b border-border/60 bg-background px-4 pt-4"
        data-testid="run-detail-chrome"
      >
        {chrome}
        {/* mt#3691 — the multi-conversation switcher, PINNED. It used to sit in
            the Conversation tab's scrolling body, so on the one surface an
            operator reads it from — a transcript that auto-scrolls to its live
            edge — it was off-screen the moment the page settled. It also
            belongs above the presence chip rather than beside the transcript:
            it selects the conversation that chip, the Context tab, and the Film
            tab all key on, so its effect is chrome-wide and not tab-local.
            Rendered on every tab for that reason; the trigger condition (>1
            candidate) is unchanged, which keeps it hidden for the ~85% of
            workspaces that have exactly one conversation. */}
        {keySpace === "workspace" &&
          conversationCandidates.length > 1 &&
          activeConversationId && (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="conversation-switcher"
            >
              <span className="shrink-0">Conversation</span>
              {/* `value` must be a definite string: Radix treats a nullish
                  `value` as UNCONTROLLED, which would let this Select's own
                  internal state drift from `selectedConversationId`. The
                  guard above already implies a candidate exists; narrowing
                  on `activeConversationId` makes that explicit to the type
                  system instead of papering over it with `?? undefined`. */}
              <Select
                value={activeConversationId}
                onValueChange={(v) => setSelectedConversationId(v || null)}
              >
                <SelectTrigger
                  className="h-7 max-w-[32rem] text-xs"
                  aria-label="Conversation"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {conversationCandidates.map((c) => (
                    <SelectItem
                      key={c.agentSessionId}
                      value={c.agentSessionId}
                      // The uuid stays reachable without spending a line on it
                      // (mt#3691 SC2) — it is the thing this task removed from
                      // the primary text, not from the UI.
                      title={c.agentSessionId}
                    >
                      {/* `min-w-0` is load-bearing, not defensive tidying: a
                          flex item's default `min-width: auto` refuses to
                          shrink below its content, so the `truncate` below
                          would never fire and a long label — the COMMON case,
                          since tier 1 is a full task title — would push the
                          chip and the age out of the pinned bar instead of
                          ellipsizing. */}
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">
                          {c.label ?? shortenId(c.agentSessionId)}
                        </span>
                        {c.linkType && (
                          <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                            {formatLinkType(c.linkType)}
                          </span>
                        )}
                        {c.startedAt && (
                          <span className="shrink-0 text-muted-foreground">
                            {relativeTime(c.startedAt)}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        {/* mt#3554 — conversation-keyed chrome (the presence value). Gated on a
            resolved conversation so an unlinked workspace renders nothing here
            rather than an empty or "unknown" chip. */}
        {activeConversationId && renderActiveConversationChrome?.(activeConversationId)}
        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList className="h-8 gap-0.5 bg-transparent p-0 border-0">
            {runTabsFor(keySpace).map((t) => (
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

        {/* mt#3400 — the driven banner lives INSIDE the pinned chrome. It used
            to sit just below it, which meant that on the Conversation tab it
            scrolled out of view immediately (the transcript auto-scrolls to its
            live edge), so the only route back to the interactive drive view
            vanished exactly where an operator reading the conversation would
            look for it. mt#3344 pinned the chrome but left this outside it.
            `mb-2` rather than padding on the container: the no-banner case must
            keep the chrome's existing geometry unchanged. */}
        {driven && (
          <Link
            to={`/driven/${encodeURIComponent(driven.sessionId)}`}
            className={`mb-2 flex items-center gap-2 rounded border px-3 py-2 text-sm transition-colors ${
              drivenActive
                ? "border-amber-500/40 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"
                : "border-border bg-muted/40 text-muted-foreground hover:bg-accent/40"
            }`}
            aria-label={`Open the drive view (${driven.status})`}
          >
            {drivenActive && (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
            )}
            {drivenActive
              ? "This conversation is live — open the drive view to interact"
              : `This conversation is ${driven.status} — open the drive view`}
          </Link>
        )}
      </div>

      {tab === "overview" && (
        <OverviewTab
          keySpace={keySpace}
          id={dataId}
          workspaceData={workspaceQuery.data}
          workspaceQuery={workspaceQuery}
          conversationData={conversationOverviewQuery.data}
          conversationQuery={conversationOverviewQuery}
        />
      )}

      {tab === "conversation" && (
        <div className="flex flex-col gap-2">
          {keySpace === "workspace" && workspaceQuery.isPending ? (
            <LoadingState message="Loading conversation…" />
          ) : activeConversationId ? (
            <ConversationView
              sessionId={activeConversationId as ConversationId}
              liveByConversationId
              onNotFound={onConversationNotFound}
              turnTarget={turnTarget}
              filmPath={filmPath}
              // Passed IN rather than rendered as a sibling below (mt#3843).
              // As a sibling it landed in the same stacking context as the
              // thread's own bottom-pinned controls at the same `z-10`, so
              // being last in DOM order it painted over the position pill and
              // took the click meant for its `↑ start` button. Inside, the
              // thread's `ThreadFooter` stacks them.
              tail={renderActiveConversationTail?.(activeConversationId)}
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

      {/*
        Film tab (mt#3461). Unlike the three text tabs, the film needs a BOUNDED
        HEIGHT to lay out at all: `SessionFilm` is a flex column whose ribbon and
        stage both fill their parent, so with no height it collapses to zero —
        the same trap `src/cockpit/CLAUDE.md` documents for react-flow, and one
        that unit tests cannot catch (happy-dom reports every rect as 0).

        The height subtracts the chrome ABOVE the film from the viewport: the
        3.5rem sticky AppHeader, the page wrapper's `p-4`, and the pinned
        run-detail chrome (label + presence + tab strip). The `min-h` floor keeps
        it usable on a short window instead of collapsing toward nothing.
        Measured against the running cockpit rather than derived — see this
        task's live-verification note.

        Width is handled by `ConversationPage` dropping `max-w-4xl` on this tab:
        a prose column would squeeze the stage back below what mt#3226 SC 1 and
        mt#3258 SC 4 twice widened it to. Only that page needs the branch — the
        film is conversation-only (mt#3468).
      */}
      {tab === "film" && activeConversationId && (
        <div className="flex h-[calc(100vh-13rem)] min-h-[28rem] flex-col">
          <SessionFilm key={activeConversationId} conversationId={activeConversationId} />
        </div>
      )}
    </div>
  );
}
