/**
 * useEntityIndex — shared hook that builds the known-entity id-set used to
 * linkify bare references (mt#NNNN, UUIDs) in transcript text AND in any
 * Markdown-rendered prose surface (task specs, memory bodies, ask questions)
 * via `<Prose entityIndex={...}>` (mt#2550).
 *
 * Extracted from ConversationView (mt#2518/mt#2374) so every prose render site
 * can share one index without each widget re-implementing the fetch wiring.
 *
 * IMPORTANT: these queries use DISTINCT cache keys from CommandPalette's queries
 * to prevent cache poisoning. CommandPalette's tasks key ("command-palette-tasks")
 * caches PaletteTask[] (objects with a `type` field); entity-index fetches only
 * string[] ids via /api/tasks/ids. Sharing the key would corrupt the cache:
 * whichever component fills it first wins, and the other reads objects of the
 * wrong shape — causing entityToPath(undefined, id) → navigate(undefined).
 *
 * Cache isolation trade-off: opening the palette no longer warms the entity-
 * index cache for free. The widget-data queries (agents, attention, memories)
 * DO share keys with CommandPalette because their shapes are compatible
 * (both extract only ids from the WidgetData wrapper).
 *
 * FRESHNESS (mt#3732): every query below sets `refetchInterval`, not just
 * `staleTime`. Linkification is id-set gated — `resolveEntityId` returns null for
 * an id the index doesn't hold, and the ref renders as plain text — so an id-set
 * that never revalidates makes every entity created AFTER mount permanently
 * unlinkable in that view. `staleTime` alone does not revalidate anything: it only
 * says how long cached data counts as fresh, and the three triggers that would
 * refetch a stale query (query mount, window refocus, network reconnect) never fire
 * on a long-mounted page whose app disables `refetchOnWindowFocus` (`main.tsx`).
 * Measured before the fix: `/api/tasks/ids` fired exactly once over ~4 minutes on a
 * live page whose sibling widget queries polled throughout.
 *
 * The driven-session view is the surface that made this visible, because it is the
 * one where an agent mints ids in front of the operator and then references them
 * seconds later.
 *
 * Cadence: 60s, matching the two existing hooks over the same data class —
 * `useReadyCount` and `useTaskBacklogCounts`, both `staleTime: 30s` /
 * `refetchInterval: 60s` ("breath-clock"). This is the baseline layer mt#1148
 * ("polling v0 with SSE migration adapter") assumes; `sse-client.ts` can later
 * invalidate these keys for faster-than-polling freshness without changing this.
 * `refetchIntervalInBackground` is deliberately left at its `false` default, so a
 * hidden tab stops polling.
 *
 * @see entity-linkifier.tsx — the tokenizer + rehype plugin that consume the index
 * @see mt#2518 — original linkifier; mt#2550 — Markdown rendering that reuses this
 * @see mt#3732 — the mount-time-snapshot bug the refetchIntervals below fix
 */
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { buildEntityIndex, type EntityIndex, type ShortIdAlias } from "./entity-linkifier";
import type { RoutableEntityType } from "./entity-codec";
import { fetchWidgetData, type WidgetData } from "./widget-client";
import type { ChangesetsListResponse } from "../widgets/Changesets";
import { extractConversationRows } from "./conversations-source";

/**
 * Revalidation cadence for every id-set query `useEntityIndex` composes — the
 * "breath-clock" 60s this codebase already uses for task-shaped data
 * (`useReadyCount`, `useTaskBacklogCounts`). See the module header for why an
 * interval is required at all and why 60s rather than a fresh number.
 */
const ENTITY_INDEX_REFETCH_MS = 60_000;

/**
 * Fetch ALL task ids from the uncapped /api/tasks/ids endpoint (mt#2518 R5).
 * Returns a string[] of every task id regardless of status — no 500 cap.
 * The linkifier uses only the ids (not titles/statuses), so the ids-only
 * endpoint is the correct target: cheaper and guaranteed comprehensive.
 */
async function fetchAllTaskIds(): Promise<string[]> {
  try {
    const res = await fetch("/api/tasks/ids");
    if (!res.ok) return [];
    const data = (await res.json()) as { ids?: string[] };
    if (!Array.isArray(data?.ids)) return [];
    return data.ids;
  } catch {
    return [];
  }
}

function extractAgentSessionIds(data: WidgetData | undefined): string[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { agents?: { sessionId: string }[] };
  if (!Array.isArray(payload?.agents)) return [];
  return payload.agents.map((a) => a.sessionId);
}

/**
 * `ws#N` → sessionId aliases from the same agents payload (mt#3259). Rows
 * without a short id (conversation-derived rows, or workspaces predating the
 * backfill) are filtered out — an alias with no canonical target could only
 * link to itself, which is the non-canonical address the alias indirection
 * exists to avoid.
 */
function extractAgentSessionShortIds(data: WidgetData | undefined): ShortIdAlias[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { agents?: { sessionId: string; shortId?: string | null }[] };
  if (!Array.isArray(payload?.agents)) return [];
  return payload.agents
    .filter((a) => Boolean(a.shortId))
    .map((a) => ({ shortId: a.shortId as string, id: a.sessionId }));
}

/**
 * `ask#N` → uuid aliases (mt#3259, re-sourced mt#4095).
 *
 * Fetched from the uncapped, state-agnostic `/api/asks/ids` rather than read
 * out of the attention widget's payload. That payload is the RADIATOR feed —
 * pending operator asks in the active service window — so an `ask#N` written in
 * a memory, a task spec or a transcript linkified while its ask was open and
 * silently stopped resolving the moment it closed. Nothing errored; the ref
 * just quietly became plain text, which is why it went unnoticed.
 *
 * Fails open to `[]`, matching every other channel here: an asks-endpoint
 * hiccup must not break linkification for the other entity types.
 */
async function fetchAskShortIds(): Promise<ShortIdAlias[]> {
  try {
    const res = await fetch("/api/asks/ids");
    if (!res.ok) return [];
    const data = (await res.json()) as { ids?: { shortId: string; id: string }[] };
    if (!Array.isArray(data?.ids)) return [];
    return data.ids.filter((r) => Boolean(r?.shortId) && Boolean(r?.id));
  } catch {
    return [];
  }
}

function extractMemoryIds(data: WidgetData | undefined): string[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { records?: { id: string }[] };
  if (!Array.isArray(payload?.records)) return [];
  return payload.records.map((r) => r.id);
}

/**
 * `mem#N` → uuid aliases from the same memories-list payload (mt#3259). This
 * one needed NO payload change — `MemoryRecord.shortId` was already
 * serialized (`packages/domain/src/memory/types.ts`, populated by
 * `rowToRecord`), so memory short-id linkification costs zero additional
 * requests.
 */
function extractMemoryShortIds(data: WidgetData | undefined): ShortIdAlias[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { records?: { id: string; shortId?: string | null }[] };
  if (!Array.isArray(payload?.records)) return [];
  return payload.records
    .filter((r) => Boolean(r.shortId))
    .map((r) => ({ shortId: r.shortId as string, id: r.id }));
}

/**
 * Fetch open/draft changeset entries (PR number + title + state) for
 * linkification gating AND label resolution (mt#3174 — widened from an
 * ids-only fetch so the label channel is free for this type; see the module
 * header's "Only TASKS need a new server channel" note). Returns [] on
 * error — fail-open so a changeset-endpoint hiccup doesn't break transcript
 * linkification for every other entity type.
 *
 * The id is the server-supplied `changesetId` (mt#4724), NOT `String(pr.number)`.
 * A PR number is unique only per-repository, so keying by the bare number
 * collapsed PR #42 in two projects onto one entry — whichever arrived last won
 * both the id-set gate and the label. The server qualifies non-default-project
 * rows as `owner/repo#N`, so the two now occupy distinct keys.
 */
async function fetchChangesetEntries(): Promise<
  { id: string; title: string | null; state: string }[]
> {
  try {
    const res = await fetch("/api/changesets");
    if (!res.ok) return [];
    const data = (await res.json()) as ChangesetsListResponse;
    if (!Array.isArray(data?.changesets)) return [];
    return data.changesets
      .filter((c) => c.pr.number != null)
      .map((c) => ({
        id: c.changesetId ?? String(c.pr.number),
        title: c.pr.title,
        state: c.pr.state,
      }));
  } catch {
    return [];
  }
}

/**
 * Extract conversation ids (harness agentSessionIds) from the shared
 * context-inspector conversations-picker payload (mt#2769). Distinct id-space
 * from `extractAgentSessionIds` above (Minsky workspace sessionIds).
 */
function extractConversationIds(data: WidgetData | undefined): string[] {
  return extractConversationRows(data).map((row) => row.agentSessionId);
}

// ---------------------------------------------------------------------------
// Label channel (mt#3174) — additive, non-gating label resolution
// ---------------------------------------------------------------------------

/**
 * A resolved human label for an entity reference, plus an optional short
 * status/state string when the source payload carries one cheaply. Consumed
 * by `<EntityRef>` and by `<Prose>`'s anchor override for the hover-card
 * content. NEVER gates linkification — see the module header: label
 * resolution is a strictly additive second channel over the id-set that
 * gates the linkifier (`EntityIndex`, built by `useEntityIndex` above).
 */
export interface EntityLabelInfo {
  label: string;
  status?: string;
}

/** id -> {label, status?}, spanning every entity type. */
export type EntityLabelIndex = Map<string, EntityLabelInfo>;

function extractAgentSessionLabels(data: WidgetData | undefined): [string, EntityLabelInfo][] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as {
    agents?: { sessionId: string; title: string; liveness: string | null }[];
  };
  if (!Array.isArray(payload?.agents)) return [];
  // Keyed by the CANONICAL id only: the linkifier resolves every reference
  // form (uuid or `ws#N`) to the canonical id before it reaches
  // `data-entity-id`, so a short-id anchor looks its label up under the same
  // key a uuid anchor does (mt#3259).
  return payload.agents.map((a) => [
    a.sessionId,
    { label: a.title, status: a.liveness ?? undefined },
  ]);
}

function extractAskLabels(data: WidgetData | undefined): [string, EntityLabelInfo][] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { cohort?: { id: string; title: string; state?: string }[] };
  if (!Array.isArray(payload?.cohort)) return [];
  return payload.cohort.map((a) => [a.id, { label: a.title, status: a.state }]);
}

function extractMemoryLabels(data: WidgetData | undefined): [string, EntityLabelInfo][] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { records?: { id: string; name: string }[] };
  if (!Array.isArray(payload?.records)) return [];
  return payload.records.map((r) => [r.id, { label: r.name }]);
}

function extractConversationLabels(data: WidgetData | undefined): [string, EntityLabelInfo][] {
  return extractConversationRows(data).map((row) => [row.agentSessionId, { label: row.label }]);
}

function labelsFromChangesetEntries(
  entries: { id: string; title: string | null; state: string }[]
): [string, EntityLabelInfo][] {
  return entries
    .filter((c) => c.title != null)
    .map((c) => [c.id, { label: c.title as string, status: c.state }]);
}

/**
 * Build a label index for the FIVE non-task entity types from the SAME
 * widget-data payloads `useEntityIndex` already fetches for gating — no new
 * network request (verified: identical `queryKey`s, so TanStack Query dedupes
 * against any already-mounted `useEntityIndex`/`useEntityLabels` instance on
 * the page). Tasks are excluded here — see `useTaskLabel` below for the one
 * genuinely new channel.
 */
export function useEntityLabels(): EntityLabelIndex {
  const [agentsQ, attentionQ, memoriesQ, changesetsQ, conversationsQ] = useQueries({
    queries: [
      {
        queryKey: ["agents"],
        queryFn: () => fetchWidgetData("agents"),
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
      {
        queryKey: ["attention"],
        queryFn: () => fetchWidgetData("attention"),
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
      {
        queryKey: ["widget", "memories-list", "", "", true],
        queryFn: () => fetchWidgetData("memories-list", { excludeSuperseded: "true" }),
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
      {
        queryKey: ["entity-index", "changesets"],
        queryFn: fetchChangesetEntries,
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
      {
        queryKey: ["context-inspector", "sessions"],
        queryFn: () => fetchWidgetData("context-inspector"),
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
    ],
  });

  return useMemo(() => {
    const index: EntityLabelIndex = new Map();
    for (const [id, info] of extractAgentSessionLabels(agentsQ.data as WidgetData | undefined))
      index.set(id, info);
    for (const [id, info] of extractAskLabels(attentionQ.data as WidgetData | undefined))
      index.set(id, info);
    for (const [id, info] of extractMemoryLabels(memoriesQ.data as WidgetData | undefined))
      index.set(id, info);
    for (const [id, info] of labelsFromChangesetEntries(
      (changesetsQ.data as { id: string; title: string | null; state: string }[] | undefined) ?? []
    ))
      index.set(id, info);
    for (const [id, info] of extractConversationLabels(
      conversationsQ.data as WidgetData | undefined
    ))
      index.set(id, info);
    return index;
  }, [agentsQ.data, attentionQ.data, memoriesQ.data, changesetsQ.data, conversationsQ.data]);
}

// ---------------------------------------------------------------------------
// Task label channel — the one genuinely new server request (mt#3174)
// ---------------------------------------------------------------------------

async function fetchTaskMeta(ids: string[]): Promise<Map<string, EntityLabelInfo>> {
  const result = new Map<string, EntityLabelInfo>();
  if (ids.length === 0) return result;
  try {
    const qs = ids.map(encodeURIComponent).join(",");
    const res = await fetch(`/api/tasks/meta?ids=${qs}`);
    if (!res.ok) return result;
    const data = (await res.json()) as { tasks?: { id: string; title: string; status: string }[] };
    if (!Array.isArray(data?.tasks)) return result;
    for (const t of data.tasks) result.set(t.id, { label: t.title, status: t.status });
  } catch {
    // fail-open — empty map; callers degrade to bare id (no title/status)
  }
  return result;
}

/**
 * Coalesces same-tick `load(id)` calls for DIFFERENT task ids into ONE
 * `/api/tasks/meta` request (a microtask-batched loader, the client-side
 * mirror of the server's `TaskTitleCache` batch discipline). Every mounted
 * `<EntityRef type="task">` — or hover-triggered task anchor — calls `load`
 * with its own id; as long as those calls happen within the same
 * synchronous flush (React runs all mount effects for a commit before
 * yielding to the microtask queue), they land in one network request
 * instead of K. This is what makes "K references -> 1 request" hold even
 * though each caller only knows its own id.
 */
class TaskMetaBatcher {
  private pendingIds = new Set<string>();
  private waiters = new Map<string, Array<(v: EntityLabelInfo | null) => void>>();
  private flushScheduled = false;

  load(id: string): Promise<EntityLabelInfo | null> {
    return new Promise((resolve) => {
      this.pendingIds.add(id);
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    const ids = Array.from(this.pendingIds);
    const waiters = this.waiters;
    this.pendingIds = new Set();
    this.waiters = new Map();
    this.flushScheduled = false;

    const results = await fetchTaskMeta(ids);
    for (const [id, callbacks] of waiters) {
      const meta = results.get(id) ?? null;
      for (const cb of callbacks) cb(meta);
    }
  }
}

const taskMetaBatcher = new TaskMetaBatcher();

/**
 * Resolve `{label, status}` for a single task id via the batched loader
 * above. Returns `null` while loading, on a lookup miss, or on any label-
 * channel failure — the caller degrades to bare-id rendering in every case
 * (failure-tolerant per mt#3174's hard requirement).
 */
export function useTaskLabel(id: string | undefined): EntityLabelInfo | null {
  const query = useQuery({
    queryKey: ["entity-index", "task-label", id],
    queryFn: () => taskMetaBatcher.load(id as string),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: false,
  });
  return query.data ?? null;
}

/**
 * Resolve `{label, status}` for ANY routable entity type — the single entry
 * point `<EntityRef>` uses. Dispatches to the batched task channel for
 * `type: "task"`; every other type resolves from the free client-side
 * extraction in `useEntityLabels`. Both underlying hooks are called
 * unconditionally (rules-of-hooks) regardless of `type`.
 *
 * A type with no label channel resolves to `null`, which is the correct
 * answer rather than a gap: `interceptor` (mt#4010) is keyed by `guardName`,
 * and that id is already the human-readable label, so there is nothing to
 * look up.
 */
export function useResolvedEntityLabel(
  type: RoutableEntityType,
  id: string
): EntityLabelInfo | null {
  const taskLabel = useTaskLabel(type === "task" ? id : undefined);
  const otherLabels = useEntityLabels();
  return type === "task" ? taskLabel : (otherLabels.get(id) ?? null);
}

/**
 * Build the entity index from data fetched for linkification purposes.
 * Returns an always-present EntityIndex (may be empty on load or error).
 */
export function useEntityIndex(): EntityIndex {
  const [tasksQ, agentsQ, memoriesQ, changesetsQ, conversationsQ, askIdsQ] = useQueries({
    queries: [
      {
        // Distinct key from CommandPalette's "command-palette-tasks" — different shape
        // (string[] here via /api/tasks/ids vs PaletteTask[] there; sharing would
        // poison the cache). Uses the uncapped ids-only endpoint (mt#2518 R5) so the
        // id-set is comprehensive — no 500-task cap.
        queryKey: ["entity-index", "tasks"],
        queryFn: fetchAllTaskIds,
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
      {
        queryKey: ["agents"],
        queryFn: () => fetchWidgetData("agents"),
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
      // The ["attention"] widget query used to live here, feeding the ask
      // id-set and alias map. Both moved to /api/asks/ids (mt#4095), which is
      // state-agnostic, so this hook no longer reads the radiator cohort at
      // all — and subscribing to a query it never reads would only re-render
      // it every refetch.
      {
        queryKey: ["widget", "memories-list", "", "", true],
        queryFn: () => fetchWidgetData("memories-list", { excludeSuperseded: "true" }),
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
      {
        // Distinct key from ChangesetsPage's ["changesets"] — different shape
        // (entries with {id,title,state} here vs ChangesetsListResponse there;
        // sharing the key would corrupt the cache). Fail-open (returns [] on
        // error). Widened from ids-only to {id,title,state} entries (mt#3174)
        // so this same query also backs `useEntityLabels`'s changeset labels —
        // no new request, same cache entry (see `fetchChangesetEntries`).
        queryKey: ["entity-index", "changesets"],
        queryFn: fetchChangesetEntries,
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
      {
        // Shared key with ConversationPage's ["context-inspector", "sessions"]
        // (the retired ConversationsPage list used the same key pre-mt#2767) —
        // both fetch the raw WidgetData wrapper and extract different projections
        // of it (rows vs ids here), the same compatible-shape sharing pattern the
        // module header documents for agents/attention/memories (mt#2769).
        queryKey: ["context-inspector", "sessions"],
        queryFn: () => fetchWidgetData("context-inspector"),
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
      {
        // The ask id channel (mt#4095). Distinct key from ["attention"] — that
        // one is the radiator widget's payload and carries pending asks only.
        queryKey: ["entity-index", "ask-ids"],
        queryFn: fetchAskShortIds,
        staleTime: 30_000,
        refetchInterval: ENTITY_INDEX_REFETCH_MS,
      },
    ],
  });

  // One fetch answers BOTH ask channels (mt#4095). `askIds` gates a bare uuid
  // in prose and `askShortIds` gates an `ask#N`; both were read out of the
  // pending-only attention cohort, so both stopped resolving when an ask
  // closed. Fixing only the short-id half would have left the same defect
  // behind under a different ref shape.
  const askAliases = (askIdsQ.data as ShortIdAlias[] | undefined) ?? [];

  return useMemo(
    () =>
      buildEntityIndex({
        taskIds: (tasksQ.data as string[] | undefined) ?? [],
        sessionIds: extractAgentSessionIds(agentsQ.data as WidgetData | undefined),
        askIds: askAliases.map((a) => a.id),
        memoryIds: extractMemoryIds(memoriesQ.data as WidgetData | undefined),
        changesetIds: (
          (changesetsQ.data as { id: string; title: string | null; state: string }[] | undefined) ??
          []
        ).map((c) => c.id),
        conversationIds: extractConversationIds(conversationsQ.data as WidgetData | undefined),
        memoryShortIds: extractMemoryShortIds(memoriesQ.data as WidgetData | undefined),
        askShortIds: askAliases,
        sessionShortIds: extractAgentSessionShortIds(agentsQ.data as WidgetData | undefined),
      }),
    // `askIdsQ.data` is load-bearing (PR #2965 R1): without it the index never
    // recomputes when /api/asks/ids refreshes, so a newly-created ask's `ask#N`
    // stays unlinkified until some UNRELATED query happens to change.
    //
    // `attentionQ.data` is deliberately NOT here any more — nothing in the memo
    // body reads it since the ask channels moved off the cohort. Leaving it
    // would have masked the missing dep above: attention refetches on the same
    // interval, so the index would recompute anyway and the staleness would
    // only show up if that query ever went quiet.
    [tasksQ.data, agentsQ.data, memoriesQ.data, changesetsQ.data, conversationsQ.data, askIdsQ.data]
  );
}
