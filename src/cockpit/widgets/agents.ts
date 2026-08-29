/**
 * Agents widget (mt#1145; unified into the mt#2767 run list)
 *
 * Live view of SessionRecord entries: liveness, task binding, PR state.
 * Filters out orphaned sessions and sessions in terminal statuses (MERGED, CLOSED).
 *
 * mt#2767 ("Unified run list"): this widget now ALSO merges in standalone
 * harness conversations (principal conversations, and subagent conversations
 * collapsed under their parent) via the optional `getConversationDb` factory
 * — see `./run-merge.ts` for the merge/dedup/grouping logic. When
 * `getConversationDb` is omitted (as in every pre-existing test in this repo)
 * or returns null, the widget behaves EXACTLY as before: workspace rows only.
 * This keeps the widget's payload backward compatible for callers that only
 * care about dispatched-agent rows (e.g. CommandPalette's Sessions group).
 *
 * The widget is constructed via createAgentsWidget(), which accepts a
 * getSessionProvider async factory, an optional getTaskProvider async factory,
 * and an optional getConversationDb async factory so the cockpit server can
 * inject the real persistence providers while tests inject lightweight doubles.
 *
 * The default export `agentsWidget` uses lazy PersistenceService singletons
 * for production use (no DI container needed).
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import type { SessionProviderInterface, SessionRecord } from "@minsky/domain/session/types";
import { SessionStatus } from "@minsky/domain/session/types";
import { deriveSessionLiveness } from "@minsky/domain/session/types";
import type { SessionAttachment } from "@minsky/domain/session/index";
import { resolveInterfaceBinding } from "@minsky/domain/interface-binding/index";
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";
import { TaskTitleCache, type TaskProviderLike } from "../task-title-cache";
import { createCachedRunMerge, type RunKind, type SubagentEntry } from "./run-merge";
import { ALL_PROJECTS, isAllProjects, type ProjectScope } from "@minsky/domain/project/scope";
import { resolveDerivedConversationLinks } from "../derived-conversation-link";
import { describeWidgetDegradedReason } from "../db-providers";
import {
  deriveRowAttachState,
  groupAttachmentsBySessionId,
  type RowAttachState,
} from "../attachment-state";

// Re-exported so other server-side consumers of AgentRow can reference the
// type from this module directly (mt#2286). The frontend keeps its own
// inline mirror (web/widgets/Agents.tsx — no server-code imports there).
export type { RowAttachState };

// Re-exported for backward compatibility — callers that imported
// `TaskProviderLike` from this module keep working; the canonical definition
// now lives in `../task-title-cache` (mt#2770, shared with the context-inspector
// widget's conversation-labeling task-title lookup).
export type { TaskProviderLike };

// Re-exported so consumers of AgentRow don't need a second import for the
// merge-produced fields (mt#2767).
export type { RunKind, SubagentEntry };

/**
 * Shape of a single run row emitted in the payload (mt#2767 — formerly
 * "agent row", widened to cover the unified run list).
 *
 * `sessionId` is the unique row key: a Minsky workspace sessionId for
 * `kind: "dispatched-agent"` rows (unchanged from the pre-mt#2767 shape),
 * else the row's own conversationId, or a synthetic `group:<parentId>` id
 * for a collapsed subagent group whose parent isn't in the current window
 * (see `./run-merge.ts`).
 */
export interface AgentRow {
  sessionId: string;
  /** Kind badge (mt#2767 Row model). Always "dispatched-agent" pre-mt#2767. */
  kind: RunKind;
  /**
   * The workspace's `ws#N` short id (ADR-029), when it has one. Null for
   * conversation-derived rows, which are not workspaces and have no short id,
   * and for workspace rows minted before the short-id backfill. Consumed by
   * the entity linkifier's id-set so a bare `ws#42` in prose resolves
   * (mt#3259); never a substitute for `sessionId`, which stays the row key.
   */
  shortId: string | null;
  title: string;
  /** Null for conversation-derived rows (principal-conversation / subagent-group) — the liveness dot only applies to workspace sessions. */
  liveness: "healthy" | "idle" | "stale" | "orphaned" | null;
  taskId: string | null;
  /** Human-readable task title sourced from the task backend; null when taskId
   *  is absent or the task could not be resolved. */
  taskTitle: string | null;
  prNumber: number | null;
  prStatus: string | null;
  lastActivityAt: string;
  agentId: string | null;
  /**
   * Best-linked conversation id (mt#2441/mt#2756 join) for a workspace row,
   * or the row's own conversation id for a conversation-derived row. Null
   * when a workspace row has no resolved conversation link. Drives the
   * live-tail indicator on the frontend (cross-referenced against
   * `useActiveConversationSessions`).
   */
  conversationId: string | null;
  /** Conversation cwd, when known. */
  cwd: string | null;
  /** Subagent conversations collapsed under this row (mt#2767 grouping) — empty when none. */
  subagents: SubagentEntry[];
  /**
   * Model the row's own conversation ran on (mt#3070), sourced from
   * `agent_transcripts.model` via the run-merge join — see run-merge.ts's
   * module doc for the plan-time populated-ness finding. `null` when
   * unknown (no linked conversation, or the transcript row has no model
   * recorded); the frontend renders that as an explicit unknown state,
   * never a guess.
   */
  model: string | null;
  /**
   * Row attachment-state (mt#2286), derived from the row's live mt#2284
   * attachment set via `deriveRowAttachState`. Only ever populated for
   * `kind: "dispatched-agent"` rows — that is the only kind whose
   * `sessionId` is a Minsky workspace sessionId, the grain mt#2284's
   * presence claims are keyed on. `null` for every other kind, and for a
   * dispatched-agent row when no attachment source was supplied (or the
   * lookup degraded) — the frontend's "go to" action treats `null` the same
   * as `"detached"` (fails closed rather than guessing).
   */
  attachState: RowAttachState | null;
  /**
   * App-started driven-session binding (mt#2752). Non-null when this row IS
   * a driven session (`kind: "driven-session"`) or when a workspace row has
   * a driven session attached to it (launched against that workspace).
   * `sessionId` addresses `/driven/:id`; `status` is the host's lifecycle
   * status. This is the driven-vs-observed distinction (spec SC4): rows with
   * `driven` carry the input affordance, rows without stay observe-only.
   */
  driven: { sessionId: string; status: string } | null;
  /**
   * Local-Minsky-only iTerm-tab binding (mt#1628). Always present for a
   * `dispatched-agent` row (via `resolveInterfaceBinding`'s `unbound`
   * default), `null` for every other row kind — same "only ever populated
   * for workspace-session rows" scoping as `attachState` above, since this
   * is a distinct question from attachment ("is a live iTerm2 tab still
   * open for this session," not "is anything self-registered as attached").
   */
  interfaceBinding: { kind: string; surfaceId?: string; lastObservedAt: string } | null;
  /**
   * Project this row is attributed to (mt#4728). For a `dispatched-agent`
   * row, `record.projectId` (set at workspace creation). For a
   * conversation-derived row (`principal-conversation` / `subagent-group`),
   * `agent_transcripts.project_id` via the run-merge join — see
   * `run-merge.ts`'s `StandaloneRunRow.projectId` doc comment for the
   * NULL-attribution rule (never hidden, shown under every filter) and the
   * synthetic-group aggregation carve-out. For a `driven-session` row
   * (mt#4732), `DrivenSessionSnapshot.projectId` — resolved at launch time
   * from the bound workspace when one exists, `null` for an unbound launch
   * (scratch/explicit-cwd/principal-channel/entity-thread) or a
   * daemon-restart rehydration (see that field's doc comment). Unlike the
   * conversation-derived NULL rule above, a driven session's `null` is
   * folded into the SAME `unattributed-summary` aggregate under a specific
   * project filter rather than kept as its own top-level row — see
   * `spliceDrivenSessions`. This field exists so a future frontend pass CAN
   * render a project badge/distinction; this task does not add that
   * rendering (sibling mt#4729).
   */
  projectId: string | null;
}

/**
 * Snapshot shape the driven-session source provides (mt#2752) — a structural
 * subset of ../driven-session-host.ts's DrivenSessionRecord, so the
 * production factory can pass registry records straight through while tests
 * construct plain objects.
 */
export interface DrivenSessionSnapshot {
  localId: string;
  cwd: string;
  status: string;
  startedAt: string;
  taskId: string | null;
  minskySessionId: string | null;
  harnessSessionId: string | null;
  /**
   * Project attribution (mt#4732), sourced from
   * `DrivenSessionRecord.projectId` — resolved by the launch-time caller from
   * the bound workspace's own `SessionRecord.projectId` when one exists (see
   * that field's doc comment in `../driven-session-host.ts`). `null` for a
   * launch with no bound workspace (scratch, explicit cwd, the ambient
   * principal channel, entity threads) and for a session rehydrated from the
   * `driven_sessions` table after a daemon restart (the schema doesn't
   * persist this column) — an honest "not tracked for this row", not a
   * guess. See `spliceDrivenSessions`'s NULL-attribution handling below.
   */
  projectId: string | null;
}

/** Full payload returned by this widget when state === "ok" */
export interface AgentsPayload {
  agents: AgentRow[];
  totalCount: number;
  /**
   * Workspace rows withheld by the default activity bound (mt#3118). Zero when
   * `?includeInactive=true`. Surfaced so the UI can state what the bound hid
   * instead of silently truncating.
   */
  hiddenInactiveCount: number;
}

/** Terminal session statuses that should be filtered out */
const TERMINAL_STATUSES: Set<SessionStatus> = new Set([SessionStatus.MERGED, SessionStatus.CLOSED]);

/**
 * Age past which a workspace is dropped from the DEFAULT list view (mt#3118).
 *
 * Status alone is not a sufficient bound: `statusNotIn: [MERGED, CLOSED]`
 * below admits every record whose status never advanced, and in practice
 * status advances very rarely (measured 2026-07-23: 198 of 225 records still
 * at CREATED, 3 ever reaching MERGED, oldest activity 2025-08-14). That made
 * the operator's default view ~96% abandoned workspaces.
 *
 * Grounding, per `decision-defaults.mdc §Thresholds` (observed cadence, not a
 * round number): that rule's stall thresholds are 5 days for active work and
 * 10 days for lynchpin tracking. We deliberately bound at the LONGER of the
 * two. Hiding at the 5-day stall threshold would make a workspace disappear
 * exactly when it becomes interesting — a stalled session is a supervision
 * signal, not noise. 10 days leaves a stalled workspace visible well past the
 * point it should have been noticed, then stops carrying it forever.
 */
const INACTIVE_WORKSPACE_THRESHOLD_DAYS = 10;
const INACTIVE_WORKSPACE_THRESHOLD_MS = INACTIVE_WORKSPACE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

/**
 * Longer window granted to a workspace whose PR is cached as open/draft.
 *
 * An open PR EXTENDS the window; it does not remove it. Both halves of that
 * are grounded in the live data (measured 2026-07-23):
 *   - EXTENDS: work genuinely waiting on review can sit quiet well past the
 *     10-day bound and must stay visible.
 *   - DOES NOT REMOVE: `pullRequest.state` is a CACHED field on the session
 *     row that nothing re-syncs. 37 sessions carry state "open"; 35 of them
 *     have been inactive for 30+ days, and their PR numbers go as low as #152
 *     against a repo already past #2200. Those PRs are long since resolved —
 *     the session row was never updated. Treating a stale cache as "still
 *     needs you" would carry 11-month-old rows in the default view forever,
 *     which is the exact noise this bound exists to remove.
 *
 * The underlying defect — session rows never updated after their PR resolves —
 * is the same never-advances problem tracked on mt#1560 / mt#1910. This
 * constant bounds our exposure to it; it does not fix it.
 */
const OPEN_PR_THRESHOLD_DAYS = 30;
const OPEN_PR_THRESHOLD_MS = OPEN_PR_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

/**
 * True when a workspace record still belongs in the default (bounded) view.
 *
 * Recency is the bound. One signal OVERRIDES it: an OPEN pull request — work
 * awaiting review can legitimately sit quiet for a long time and must never
 * vanish from the operator's view while it is still open.
 *
 * "Open" is load-bearing, not decorative. An earlier revision overrode on the
 * mere PRESENCE of `record.pullRequest`, and the live check against the real
 * database caught it: the bound removed only 170 of 225 workspaces and left 55
 * behind, the oldest last active 2025-09-03. Those sessions carry a PR record
 * whose PR merged or closed months ago — the session row simply never got
 * updated (the same status-never-advances problem that produced this task).
 * Treating any PR record as "still needs you" reintroduced most of the noise
 * the bound exists to remove. `state === "draft"` also counts as open: a draft
 * PR is in-flight work, not finished work.
 *
 * Liveness deliberately gets NO separate override, though the spec's criterion
 * asks that a live workspace never be hidden. That property holds by
 * construction rather than by a branch: `deriveSessionLiveness`
 * (`packages/domain/src/session/types.ts:152`) derives from the SAME
 * `lastActivityAt ?? createdAt` timestamp this function reads, and classifies
 * anything quiet for more than 2 hours as `stale`. So a non-stale record is
 * necessarily within any bound of 2 hours or more — a liveness check here
 * could never fire independently, and writing one would be dead code that
 * reads like a live guard. If the bound is ever tightened below 2 hours, that
 * stops being true and an explicit liveness override becomes necessary.
 *
 * An unparseable or missing activity timestamp is treated as RECENT (kept),
 * not hidden: this filter's failure mode must be showing too much, never
 * silently dropping a row whose age could not be established.
 *
 * Exported for direct unit testing (the widget's `fetch` is awkward to drive
 * across the full age/PR matrix).
 */
export function isWithinActiveWindow(
  record: SessionRecord,
  now: number,
  thresholdMs: number = INACTIVE_WORKSPACE_THRESHOLD_MS
): boolean {
  const raw = record.lastActivityAt ?? record.createdAt;
  if (!raw) return true;
  const ts = new Date(raw).getTime();
  if (Number.isNaN(ts)) return true;

  const prState = record.pullRequest?.state;
  const effectiveThresholdMs =
    prState === "open" || prState === "draft"
      ? Math.max(thresholdMs, OPEN_PR_THRESHOLD_MS)
      : thresholdMs;

  return now - ts <= effectiveThresholdMs;
}

/**
 * Map a SessionRecord to an AgentRow.
 * Derives liveness via the domain function; leaves agentId as null
 * until mt#1078 populates it.
 *
 * @param record  The session record to map.
 * @param taskTitle  Pre-fetched task title (or null when unavailable).
 */
function toAgentRow(record: SessionRecord, taskTitle: string | null): AgentRow {
  const liveness = deriveSessionLiveness(record);

  // Title precedence: prefer the human-meaningful git branch when present,
  // otherwise fall back to the full sessionId. A truncated 8-char prefix
  // risks collisions and is misleading for a primary identifier (PR #1030 R1
  // reviewer finding).
  const title = record.branch ?? record.sessionId;

  // Storage may hold task IDs in either plain ("123") or qualified ("mt#123")
  // form because `SessionDbAdapter.addTaskToSession()` normalizes to qualified
  // before persisting. Delegate to the shared display formatter so we don't
  // double-prefix already-qualified IDs (PR #1030 R2 reviewer finding).
  const taskId = record.taskId ? formatTaskIdForDisplay(record.taskId) : null;

  let prNumber: number | null = null;
  let prStatus: string | null = null;
  if (record.pullRequest) {
    prNumber = record.pullRequest.number;
    prStatus = record.pullRequest.state;
  }

  const lastActivityAt = record.lastActivityAt ?? record.createdAt;

  return {
    sessionId: record.sessionId,
    kind: "dispatched-agent",
    shortId: record.shortId ?? null,
    title,
    liveness,
    taskId,
    taskTitle,
    prNumber,
    prStatus,
    lastActivityAt,
    agentId: record.agentId ?? null,
    // Filled in by mergeConversationRows() when a conversation DB is
    // available (mt#2767); default to "no linked conversation" otherwise.
    conversationId: null,
    cwd: null,
    subagents: [],
    // Filled in below (createAgentsWidget's fetch()) from the merge attrs
    // when a linked conversation carries a model (mt#3070); null by default.
    model: null,
    // Attached from the driven-session registry snapshot (mt#2752) when a
    // driven session was launched against this workspace.
    driven: null,
    // mt#1628: read-side default (undefined stored value -> explicit
    // `unbound`), same pattern as basic-commands.ts's session.get/list.
    interfaceBinding: resolveInterfaceBinding(record),
    // Filled in below (createAgentsWidget's fetch()) when a live-attachments
    // source is supplied; null otherwise (mt#2286).
    attachState: null,
    // mt#4728: the workspace's own resolved project (set at creation time).
    projectId: record.projectId ?? null,
  };
}

/** `unattributed-summary` row title, matching run-merge.ts's exact wording. */
function unattributedSummaryTitle(count: number): string {
  return `${count} unattributed conversation${count === 1 ? "" : "s"}`;
}

/** Newest-first timestamp across a current value plus a group of entries (mirrors run-merge.ts's `latestTimestamp`). */
function latestActivityAcross(current: string | null, entries: SubagentEntry[]): string {
  let latest = current;
  for (const e of entries) {
    if (e.startedAt && (!latest || e.startedAt > latest)) latest = e.startedAt;
  }
  return latest ?? new Date(0).toISOString();
}

/**
 * Splice driven-session registry snapshots into the merged row list
 * (mt#2752): a driven session whose `minskySessionId` matches a VISIBLE
 * workspace row ANNOTATES that row (`row.driven`) unconditionally — a match
 * confirms it's running against a workspace that already passed project
 * filtering upstream, so there is nothing further to check. Every other
 * driven session (untasked scratch, explicit-cwd, or a `minskySessionId`
 * whose workspace fell OUT of view under the current filter) is classified
 * by its OWN `projectId` (mt#4732):
 *
 *   - `ALL_PROJECTS` scope: unchanged pre-mt#4732 behavior — every unmatched
 *     entry becomes its own `kind: "driven-session"` row, now carrying real
 *     attribution in `projectId` instead of a hardcoded `null`.
 *   - A specific project scoped, `projectId` confirmed DIFFERENT: hidden
 *     (SC1) — mirrors the strict `eq()`-only semantics a `dispatched-agent`
 *     row already gets from `listSessions`'s project filter. Unlike
 *     `agent_transcripts.project_id` (best-effort, nullable-by-design at
 *     ingest — see run-merge.ts's NULL-attribution rule), a driven session's
 *     `projectId` is either resolved from an authoritative workspace record
 *     or genuinely unknown; there is no "ingest gap" middle state to excuse
 *     a mismatch.
 *   - A specific project scoped, `projectId` confirmed SAME: a real
 *     standalone row, same as ALL_PROJECTS.
 *   - A specific project scoped, `projectId` unresolvable (`null` — no bound
 *     workspace, or a workspace with no `projectId` of its own): folded into
 *     the SAME `unattributed-summary` aggregate mt#4733 introduced for
 *     NULL-attribution conversations (SC3/AT2), rather than shown as a full
 *     top-level peer under every foreign filter. `rows` may already contain
 *     that row (produced by `mergeConversationRows` upstream) — appended to
 *     when present, created fresh with the identical `unattributed:<scope>`
 *     id scheme otherwise, so the two sources always converge on one row.
 *
 * Exported for direct unit testing.
 */
export function spliceDrivenSessions(
  rows: AgentRow[],
  driven: DrivenSessionSnapshot[],
  projectScope: ProjectScope = ALL_PROJECTS
): AgentRow[] {
  if (driven.length === 0) return rows;

  const byWorkspaceId = new Map<string, AgentRow>();
  for (const row of rows) {
    if (row.kind === "dispatched-agent") byWorkspaceId.set(row.sessionId, row);
  }

  const collapseScoped = !isAllProjects(projectScope);
  const unattributedEntries: SubagentEntry[] = [];
  const standalone: AgentRow[] = [];

  for (const record of driven) {
    const workspaceRow = record.minskySessionId
      ? byWorkspaceId.get(record.minskySessionId)
      : undefined;
    if (workspaceRow) {
      // Latest launch wins if several driven sessions target one workspace —
      // registry order is insertion order, so the last record is newest.
      workspaceRow.driven = { sessionId: record.localId, status: record.status };
      continue;
    }

    if (collapseScoped) {
      if (record.projectId != null && record.projectId !== projectScope) {
        continue; // confirmed different project — hidden (SC1)
      }
      if (record.projectId == null) {
        const cwdTail = record.cwd.split("/").filter(Boolean).pop() ?? record.cwd;
        unattributedEntries.push({
          conversationId: record.harnessSessionId ?? `driven:${record.localId}`,
          label: record.taskId ? cwdTail : `Scratch: ${cwdTail}`,
          cwd: record.cwd,
          startedAt: record.startedAt,
          // Driven-session status doesn't carry a terminal timestamp the way
          // agent_transcripts.endedAt does (see DrivenSessionSnapshot's own
          // doc comment) — left null (renders as "still running") rather
          // than guessed.
          endedAt: null,
          model: null,
        });
        continue;
      }
      // record.projectId === projectScope: confirmed same-project data,
      // falls through to the ordinary standalone-row construction below.
    }

    const cwdTail = record.cwd.split("/").filter(Boolean).pop() ?? record.cwd;
    standalone.push({
      sessionId: record.localId,
      kind: "driven-session",
      // A driven session is addressed by its own local id, not a Minsky
      // workspace sessionId — there is no `ws#N` to carry (mt#3259).
      shortId: null,
      // SC3: an untasked scratch session is "clearly labeled" — the kind
      // badge carries "Driven"; the title marks it scratch when unbound.
      title: record.taskId ? cwdTail : `Scratch: ${cwdTail}`,
      liveness: null,
      taskId: record.taskId,
      taskTitle: null,
      prNumber: null,
      prStatus: null,
      lastActivityAt: record.startedAt,
      agentId: null,
      conversationId: record.harnessSessionId,
      cwd: record.cwd,
      subagents: [],
      // Driven-session model tracking is out of this task's scope (mt#3070
      // covers run-merge.ts's agent_transcripts join, not the driven-session
      // registry snapshot) — renders as the same explicit unknown state.
      model: null,
      driven: { sessionId: record.localId, status: record.status },
      // A driven session is inherently app-started, not a workspace row —
      // attachState (mt#2284/mt#2286) doesn't apply (mt#2286).
      attachState: null,
      // Not a Minsky workspace session -- no iTerm-tab binding question applies (mt#1628).
      interfaceBinding: null,
      // mt#4732: real attribution when resolvable. Under ALL_PROJECTS this is
      // whatever the launch resolved (possibly null); under a specific scope
      // this branch is only reached when it's confirmed equal to projectScope.
      projectId: record.projectId,
    });
  }

  let result: AgentRow[] = [...rows, ...standalone];

  if (collapseScoped && unattributedEntries.length > 0) {
    const existing = result.find((r) => r.kind === "unattributed-summary");
    if (existing) {
      existing.subagents.push(...unattributedEntries);
      existing.lastActivityAt = latestActivityAcross(existing.lastActivityAt, unattributedEntries);
      existing.title = unattributedSummaryTitle(existing.subagents.length);
    } else {
      result = [
        ...result,
        {
          sessionId: `unattributed:${projectScope}`,
          kind: "unattributed-summary",
          shortId: null,
          title: unattributedSummaryTitle(unattributedEntries.length),
          liveness: null,
          taskId: null,
          taskTitle: null,
          prNumber: null,
          prStatus: null,
          lastActivityAt: latestActivityAcross(null, unattributedEntries),
          agentId: null,
          conversationId: null,
          cwd: null,
          subagents: unattributedEntries,
          model: null,
          driven: null,
          attachState: null,
          interfaceBinding: null,
          projectId: null,
        },
      ];
    }
  }

  return result;
}

/**
 * Factory: returns a WidgetModule backed by the given session provider factory.
 *
 * @param getProvider  Async factory that returns a SessionProviderInterface.
 *   Called on each fetch() so callers can lazily initialise the provider.
 *   If the call throws, fetch() catches and returns a degraded state.
 *
 * @param getTaskProvider  Optional async factory that returns a TaskProviderLike.
 *   When provided, task titles are looked up in a single parallel batch for all
 *   unique non-null taskIds in the current session list. When absent or when the
 *   factory throws, taskTitle fields are null (graceful degradation).
 *
 * @param getConversationDb  Optional async factory returning a live Drizzle
 *   connection (mt#2767). When provided, standalone harness conversations are
 *   merged into the row list per `./run-merge.ts` — dedup against linked
 *   workspaces, subagent grouping/collapsing. When omitted, or when the
 *   factory returns null (no SQL-capable persistence provider configured),
 *   the widget returns ONLY workspace ("dispatched-agent") rows — the exact
 *   pre-mt#2767 behavior. Every pre-existing test in this repo omits this
 *   parameter, so their assertions are unaffected by the merge.
 *
 * @param getProjectScopeDb  Optional test seam (mt#3016): overrides
 *   `resolveCockpitProjectScope`'s own db-fetch for the `?project=` query
 *   param resolution. Production callers never set this — `agentsWidget`
 *   below omits it, so `resolveCockpitProjectScope` falls back to its own
 *   `defaultGetDb` (the real `getContextInspectorDb()` singleton), exactly
 *   matching pre-mt#3016 behavior. Exists because `getContextInspectorDb()`
 *   is a module-level singleton shared across every test file in the same
 *   `bun test` process, and its result depends on whatever OTHER test
 *   happened to initialize `@minsky/domain/configuration`'s own (equally
 *   global, equally un-reset) provider singleton first — confirmed
 *   empirically to make this resolve a REAL, non-null connection when
 *   `packages/domain/src/session-auto-task-creation.test.ts` runs earlier in
 *   the same process. Injecting `getProjectScopeDb` removes the dependency
 *   on that ambient, cross-file, load-order-sensitive state entirely.
 *
 * @example
 *   // Production use (cockpit default):
 *   export const agentsWidget = createAgentsWidget(
 *     defaultProviderFactory,
 *     defaultTaskProviderFactory,
 *     defaultConversationDbFactory
 *   );
 *
 *   // Test use (session provider only, no task enrichment, no conversation merge):
 *   const widget = createAgentsWidget(async () => mockProvider);
 *
 *   // Test use (with task enrichment):
 *   const widget = createAgentsWidget(async () => mockProvider, async () => mockTaskProvider);
 */
export function createAgentsWidget(
  getProvider: () => Promise<SessionProviderInterface>,
  getTaskProvider?: () => Promise<TaskProviderLike>,
  getConversationDb?: () => Promise<PostgresJsDatabase | null>,
  getDrivenSessions?: () => DrivenSessionSnapshot[],
  /**
   * Optional async factory returning every CURRENTLY LIVE mt#2284 session
   * attachment (the whole-table batch shape returned by
   * `listLiveSessionAttachments(repo)` with no `sessionId` filter — mt#2286).
   * When provided, each `dispatched-agent` row's `attachState` is derived via
   * `deriveRowAttachState`. When omitted, or when the call throws, every
   * row's `attachState` stays `null` (exact pre-mt#2286 behavior) — every
   * pre-existing test in this repo omits this parameter.
   */
  getLiveAttachments?: () => Promise<SessionAttachment[]>,
  getProjectScopeDb?: () => Promise<ScopeResolverDb | null>
): WidgetModule {
  const titleCache = getTaskProvider ? new TaskTitleCache(getTaskProvider) : null;
  // mt#2767 latency follow-up — short-TTL cache in front of the conversation
  // merge (see run-merge.ts's cache docblock for the full incident writeup).
  // One instance per widget construction, same lifetime as titleCache above.
  const cachedMerge = getConversationDb ? createCachedRunMerge() : null;

  return {
    id: "agents",
    title: "Agents",
    updateMode: { type: "polling", intervalMs: 5000 },
    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const provider = await getProvider();

        // mt#2767 pagination-semantics note (reviewer round 1): `limit`/`offset`
        // now paginate the MERGED row list (workspace rows + standalone
        // conversation/subagent-group rows), not the raw workspace-session
        // list alone. A caller passing offset/limit gets a page drawn from the
        // combined, kind-heterogeneous array below — not just dispatched-agent
        // rows. No production caller passes these params today (the frontend
        // fetches everything and paginates client-side via useListControls,
        // same as pre-mt#2767); this is a forward-looking note for whoever
        // wires server-side pagination into the UI next (mt#2084 is the prior
        // art for that pattern).
        const limit = ctx.query?.limit ? parseInt(ctx.query.limit, 10) : undefined;
        const offset = ctx.query?.offset ? parseInt(ctx.query.offset, 10) : undefined;
        const isPaginated = limit != null && !isNaN(limit);

        // Project scope (mt#2418): ?project=<slug> resolved to a project
        // uuid, defaulting to ALL_PROJECTS when omitted/"all" — same
        // resolution rules as every other cockpit project-scoped read.
        // resolveCockpitProjectScope owns its own db-fetch and never throws
        // (fail-open to ALL_PROJECTS on any resolution failure — PR #2056 R1)
        // so a scoping problem can never take this widget down. `getProjectScopeDb`
        // is the mt#3016 test seam above — undefined in production, so
        // resolveCockpitProjectScope falls back to its own defaultGetDb (the
        // real getContextInspectorDb() singleton).
        const { resolveCockpitProjectScope } = await import("../project-scope");
        const projectScope = await resolveCockpitProjectScope(ctx.query?.project, {
          getDb: getProjectScopeDb,
        });

        // Filter terminal statuses at DB level; orphaned liveness is derived
        // in JS (no DB column) so it stays as a post-fetch filter.
        const allRecords = await provider.listSessions({
          statusNotIn: [...TERMINAL_STATUSES],
          projectScope,
        });

        // mt#3118: `?includeInactive=true` restores the unbounded view. The
        // rows are hidden, never dropped from the substrate — `hiddenInactiveCount`
        // below reports how many, so the UI can surface the bound rather than
        // silently truncating (CLAUDE.md §"No silent caps").
        const includeInactive = ctx.query?.includeInactive === "true";
        const now = Date.now();

        const liveFiltered = allRecords.filter((r) => {
          const liveness = deriveSessionLiveness(r);
          if (liveness === "orphaned") return false;
          return true;
        });

        const filtered = includeInactive
          ? liveFiltered
          : liveFiltered.filter((r) => isWithinActiveWindow(r, now));
        const hiddenInactiveCount = liveFiltered.length - filtered.length;

        // Task-title + conversation-merge enrichment run over the FULL
        // filtered set, not just the requested page — pagination (when
        // requested at all) is applied to the fully-merged row list at the
        // very end. Production never passes limit/offset today (the
        // frontend fetches everything and paginates client-side via
        // useListControls), so this is behaviorally identical to the
        // pre-mt#2767 code for the only path actually exercised in
        // production; it's a widening (not a narrowing) for the
        // pagination-test path, which asserts only on session ids/counts.
        const taskTitleMap = new Map<string, string>();
        if (titleCache) {
          const uniqueTaskIds = Array.from(
            new Set(
              filtered
                .map((r) => r.taskId)
                .filter((id): id is string => id != null)
                .map(formatTaskIdForDisplay)
            )
          );
          if (uniqueTaskIds.length > 0) {
            const titles = await titleCache.getTitles(uniqueTaskIds);
            for (const [id, title] of titles) {
              taskTitleMap.set(id, title);
            }
          }
        }

        const workspaceRows: AgentRow[] = filtered.map((r) => {
          const displayTaskId = r.taskId ? formatTaskIdForDisplay(r.taskId) : null;
          const taskTitle = displayTaskId ? (taskTitleMap.get(displayTaskId) ?? null) : null;
          return toAgentRow(r, taskTitle);
        });

        // mt#2286 — annotate each workspace row with its attachment-state
        // indicator, derived from the CURRENT live mt#2284 attachment set.
        // One batch call for every row, not N — mirrors the task-title
        // enrichment above. Degrades to "every row stays null" (same as
        // omitting the factory) on any lookup failure — but UNLIKE the
        // conversation-merge/driven-session enrichments above (which are
        // cosmetic decorations), a null attachState directly changes the
        // "go to" action's behavior (it disables the row), so a swallowed
        // failure here has a higher blast radius. Logged at `warn` — not
        // `debug` — so it is operator-visible in production logs (matches
        // the established precedent for the same failure class in
        // src/adapters/shared/commands/session/attachment-annotation.ts).
        // No metrics emission here: no sibling enrichment in this file emits
        // metrics either, and adding a new mechanism is out of this task's
        // scope — tracked as a follow-up rather than expanded here.
        if (getLiveAttachments) {
          try {
            const liveAttachments = await getLiveAttachments();
            const bySessionId = groupAttachmentsBySessionId(liveAttachments);
            for (const row of workspaceRows) {
              row.attachState = deriveRowAttachState(bySessionId.get(row.sessionId) ?? []);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`[agents widget] attachment-state enrichment degraded: ${message}`);
          }
        }

        // mt#2767 — merge in standalone conversations (principal + collapsed
        // subagent groups) and dedup/attach conversation links onto the
        // workspace rows above. Degrades silently to "workspace rows only"
        // when no conversation DB is configured or the merge itself fails.
        let standaloneRows: AgentRow[] = [];
        if (getConversationDb) {
          const db = await getConversationDb().catch(() => null);
          if (db) {
            // The standalone-row merge is the only part that needs `cachedMerge`.
            // The mt#3529 derived fallback below needs the transcripts DB and
            // nothing else, so it is NOT nested under this guard — coupling the
            // two would let the list disagree with /api/agents/:id (which has no
            // merge) whenever the merge is unavailable but the DB is not.
            if (cachedMerge) {
              // mt#4728: thread the SAME projectScope resolved above through
              // to the conversation merge — this is the fix for
              // conversation-derived rows (principal-conversation /
              // subagent-group) bypassing the project filter that
              // listSessions already honors.
              const merge = await cachedMerge.getMerge(
                db,
                workspaceRows.map((r) => r.sessionId),
                projectScope
              );
              for (const row of workspaceRows) {
                const attrs = merge.workspaceAttrsBySessionId.get(row.sessionId);
                if (attrs) {
                  row.conversationId = attrs.conversationId;
                  row.cwd = attrs.cwd;
                  row.subagents = attrs.subagents;
                  row.model = attrs.model;
                }
              }
              standaloneRows = merge.standaloneRows.map((r) => ({
                ...r,
                driven: null,
                // Conversation-derived rows have no Minsky workspace sessionId
                // — attachState (mt#2284/mt#2286) doesn't apply.
                attachState: null,
                // Nor does the iTerm-tab binding question (mt#1628) — same reasoning.
                interfaceBinding: null,
                // Nor a `ws#N` short id (mt#3259) — that is a workspace handle,
                // and these rows are conversations.
                shortId: null,
              }));
            }

            // mt#3529 — rows still unresolved (whether because the merge found
            // no link row, or because there was no merge at all) fall back to
            // the conversation their own agentId names (existence-checked).
            // Runs AFTER the merge, over only the still-null rows, so a stamped
            // link always wins. This keeps the list in agreement with
            // /api/agents/:id, which applies the same fallback — a row showing
            // null here while the detail page resolved a conversation would be
            // a worse bug than the one being fixed.
            const unresolved = workspaceRows.filter((r) => r.conversationId == null);
            if (unresolved.length > 0) {
              const derived = await resolveDerivedConversationLinks(
                db,
                unresolved.map((r) => ({ sessionId: r.sessionId, agentId: r.agentId }))
              );
              for (const row of unresolved) {
                const link = derived.get(row.sessionId);
                if (link) row.conversationId = link.agentSessionId;
              }
            }
          }
        }

        // mt#2752 — splice in app-started driven sessions (annotate matching
        // workspace rows; standalone rows for scratch/unmatched). The
        // snapshot source is synchronous (in-process registry) and empty on
        // deployments with no local driven-session host (e.g. Railway).
        let drivenSnapshots: DrivenSessionSnapshot[] = [];
        if (getDrivenSessions) {
          try {
            drivenSnapshots = getDrivenSessions();
          } catch {
            drivenSnapshots = [];
          }
        }
        const merged = spliceDrivenSessions(
          [...workspaceRows, ...standaloneRows],
          drivenSnapshots,
          projectScope
        );
        const totalCount = merged.length;
        const agents = isPaginated ? merged.slice(offset ?? 0, (offset ?? 0) + limit) : merged;

        const payload: AgentsPayload = { agents, totalCount, hiddenInactiveCount };
        return { state: "ok", payload };
      } catch (err) {
        return { state: "degraded", reason: describeWidgetDegradedReason("session_list", err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default production widget
//
// Uses the cockpit-wide PersistenceService singleton (src/cockpit/shared-persistence.ts)
// so all widgets share one connection pool. The provider is created once on first
// fetch(); subsequent calls reuse the cached instance.
// ---------------------------------------------------------------------------

import { createEpochKeyedCache, getSharedPersistenceService } from "../shared-persistence";

/**
 * mt#3638: a pool recycle bumps the persistence epoch; serving the old provider
 * past that point pins a torn-down pool (the mt#2362 staleness this closes).
 *
 * mt#3721 moved the epoch bookkeeping — including the rebuild-until-stable loop
 * this file introduced in PR #2586 R1 — into `createEpochKeyedCache`, so the
 * discipline is inherited rather than re-derived here. This was the only
 * consumer that had it; eight others had no epoch check at all, which is the
 * gap that motivated extracting it.
 */
const defaultProviderFactory = createEpochKeyedCache(
  async (): Promise<SessionProviderInterface> => {
    const { createSessionProvider } = await import(
      "@minsky/domain/session/drizzle-session-repository"
    );

    const svc = await getSharedPersistenceService();
    // Awaited rather than returned directly: `custom/no-unwaited-async-factory`
    // requires an async factory's result to be awaited at its call site, so a
    // rejection surfaces here rather than inside the caller's own await.
    const provider = await createSessionProvider(undefined, {
      persistenceService: {
        isInitialized: () => true,
        getProvider: () => svc.getProvider(),
      },
    });
    return provider;
  }
);

// ---------------------------------------------------------------------------
// Default task provider — lazy singleton sharing PersistenceService with
// the session provider above (mt#2079).
//
// Uses createConfiguredTaskService (the same path the CLI uses) so the widget
// benefits from multi-backend task resolution (mt# Minsky DB + gh# GitHub).
// ---------------------------------------------------------------------------

/** mt#3638: same epoch discipline as `defaultProviderFactory` above. */
const defaultTaskProviderFactory = createEpochKeyedCache(async (): Promise<TaskProviderLike> => {
  const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");

  const svc = await getSharedPersistenceService();
  const persistenceProvider = svc.getProvider();

  return createConfiguredTaskService({
    workspacePath: process.cwd(),
    persistenceProvider,
  });
});

// ---------------------------------------------------------------------------
// Default conversation-merge DB factory (mt#2767) — reuses the cockpit-wide
// lazy-cached SQL connection getter (`db-providers.ts`) already shared by the
// context-inspector widget and the /api/agents, /api/conversation routes, so
// this doesn't open a second connection pool.
// ---------------------------------------------------------------------------

async function defaultConversationDbFactory(): Promise<PostgresJsDatabase | null> {
  const { getContextInspectorDb } = await import("../db-providers");
  return getContextInspectorDb();
}

// ---------------------------------------------------------------------------
// Default driven-session snapshot source (mt#2752) — reads the daemon-local
// in-process registry (../driven-session-host.ts). Static import is safe:
// the host module has no heavyweight/domain dependencies by design, and
// deployments that never spawn driven sessions just see an empty registry.
// ---------------------------------------------------------------------------

import { drivenSessionRegistry } from "../driven-session-host";

function defaultDrivenSessionsFactory(): DrivenSessionSnapshot[] {
  return drivenSessionRegistry.list().map((record) => ({
    localId: record.localId,
    cwd: record.cwd,
    status: record.status,
    startedAt: record.startedAt,
    taskId: record.taskId,
    minskySessionId: record.minskySessionId,
    harnessSessionId: record.harnessSessionId,
    // mt#4732 — resolved by the launch-time caller; see
    // DrivenSessionRecord.projectId's doc comment for what null means here.
    projectId: record.projectId,
  }));
}

// ---------------------------------------------------------------------------
// Default live-attachments factory (mt#2286) — reuses the SAME cockpit-wide
// SQL connection getter as the conversation-merge factory above (no second
// pool), then builds a presence-claim repository over it and reads the
// whole-table live-attachment batch (mt#2284).
// ---------------------------------------------------------------------------

async function defaultLiveAttachmentsFactory(): Promise<SessionAttachment[]> {
  const { getContextInspectorDb } = await import("../db-providers");
  const db = await getContextInspectorDb();
  if (!db) return [];

  const { buildPresenceClaimRepository } = await import("@minsky/domain/presence/index");
  const repo = buildPresenceClaimRepository(db);
  if (!repo) return [];

  const { listLiveSessionAttachments } = await import("@minsky/domain/session/index");
  return listLiveSessionAttachments(repo);
}

/** Default agents widget — ready to drop into WIDGET_REGISTRY */
export const agentsWidget: WidgetModule = createAgentsWidget(
  defaultProviderFactory,
  defaultTaskProviderFactory,
  defaultConversationDbFactory,
  defaultDrivenSessionsFactory,
  defaultLiveAttachmentsFactory
);
