/**
 * Shared entity-label resolver (mt#2883 — cockpit identity legibility).
 *
 * ONE place that turns an entity reference into a human-legible display label
 * plus its canonical anchor, consumed by the TabBar (working-set strip), the
 * CommandPalette (via the shared task-index fetcher), and ask requestor cells.
 * The product rule it implements is /product-thinking principle 10 — "derived
 * identity over raw internals": canonical anchors (`mt#X`, `#N`, short ids)
 * stay visible per cockpit-design's entity-ID conventions, but a raw internal
 * string (an id hash, an ascribed `unknown:hash:` actor, prompt text) never
 * stands ALONE as a surface's primary identity.
 *
 * Resolution reuses the SAME TanStack Query keys as the surfaces that already
 * fetch each entity family (palette task index, `agents` widget, `attention`
 * cohort, `memories-list`, `changesets` list, context-inspector conversation
 * rows) so tab labels ride existing caches instead of adding fetch load.
 * Every resolution degrades to the caller's existing fallback label (the
 * shortened id) while data is loading or the entity is outside the fetched
 * window — labels enrich, never block.
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "./widget-client";
import { extractConversationRows } from "./conversations-source";
import type { EntityTab } from "./tabs";

// ---------------------------------------------------------------------------
// Requestor formatting (pure)
// ---------------------------------------------------------------------------

/**
 * Ascribed / unattributed actor ids (ADR-006): callers without a declared
 * agent id surface either as opaque `unknown:hash:<...>` strings (minted per
 * process, churning across respawns) or as a terminal `unknown` agent
 * segment (`minsky.agent:unknown`). Both carry no stable meaning — never
 * render one as a primary label. Matched after a segment boundary, not just
 * at the start (live data carries prefixed forms — mt#2883 live audit).
 */
const ASCRIBED_ACTOR_RE = /(?:^|:)unknown(?::hash:|$)/;
const ASCRIBED_MARKER = "unknown:hash:";

export interface RequestorDisplay {
  /** Human-legible label to render. */
  label: string;
  /** The raw requestor string — expose via title/hover, never as the label. */
  raw: string;
  /** True when the requestor is an opaque ascribed identity. */
  isAscribed: boolean;
}

/**
 * Format an ask requestor for display. Ascribed `unknown:hash:` actors render
 * as "unattributed agent", contextualized by the ask's parent task when one
 * exists (e.g. "unattributed agent · mt#2505"); declared identities pass
 * through unchanged.
 */
export function formatRequestor(requestor: string, parentTaskId?: string | null): RequestorDisplay {
  if (ASCRIBED_ACTOR_RE.test(requestor)) {
    return {
      label: parentTaskId ? `unattributed agent · ${parentTaskId}` : "unattributed agent",
      raw: requestor,
      isAscribed: true,
    };
  }
  return { label: requestor, raw: requestor, isAscribed: false };
}

/**
 * Distinguishable dropdown-option label for a requestor: ascribed actors all
 * share the "unattributed agent" display name, so filter options (which must
 * stay 1:1 with raw values) append the hash prefix for disambiguation.
 */
export function formatRequestorOption(requestor: string): string {
  if (!ASCRIBED_ACTOR_RE.test(requestor)) return requestor;
  const markerIdx = requestor.indexOf(ASCRIBED_MARKER);
  if (markerIdx >= 0) {
    const start = markerIdx + ASCRIBED_MARKER.length;
    return `unattributed (${requestor.slice(start, start + 8)})`;
  }
  // Terminal-`unknown` form (e.g. "minsky.agent:unknown") — disambiguate by
  // the issuing prefix instead of a hash.
  const prefix = requestor.replace(/:?unknown$/, "");
  return prefix ? `unattributed (${prefix})` : "unattributed";
}

// ---------------------------------------------------------------------------
// Task index — shared fetcher (also consumed by CommandPalette)
// ---------------------------------------------------------------------------

export interface TaskIndexRow {
  id: string;
  title: string;
  status: string;
}

/**
 * Query key shared with the CommandPalette's task source — one cache serves
 * both the palette rows and task tab labels. (Key string predates this
 * module; kept verbatim so existing caches stay warm.)
 */
export const TASK_INDEX_QUERY_KEY = ["command-palette-tasks"] as const;

export async function fetchTaskIndex(): Promise<TaskIndexRow[]> {
  try {
    const res = await fetch("/api/tasks");
    if (!res.ok) return [];
    const data = (await res.json()) as { tasks?: TaskIndexRow[] };
    if (!Array.isArray(data.tasks)) return [];
    return data.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure per-kind resolution (exported for tests)
// ---------------------------------------------------------------------------

export interface EntityLabel {
  /** Human-legible primary label. Falls back to the tab's existing label. */
  primary: string;
  /** True when `primary` is an enriched title rather than the id fallback. */
  enriched: boolean;
}

export interface LabelSources {
  tasks: TaskIndexRow[];
  /** `agents` widget rows — workspace sessionId → bound task title/id. */
  agentRows: { sessionId: string; taskId: string | null; taskTitle: string | null }[];
  /** Context-inspector conversation rows (harness agentSessionId → ladder label). */
  conversationRows: { agentSessionId: string; label: string }[];
  /** Attention cohort rows (ask id → subject). */
  askRows: { id: string; title: string }[];
  /** Memories-list rows (memory id → name). */
  memoryRows: { id: string; name: string }[];
  /** Changesets rows (PR number → title). */
  changesetRows: { number: number | null; title: string | null }[];
}

export const EMPTY_LABEL_SOURCES: LabelSources = {
  tasks: [],
  agentRows: [],
  conversationRows: [],
  askRows: [],
  memoryRows: [],
  changesetRows: [],
};

/**
 * Resolve a tab's display label from whatever sources have data. Pure —
 * `useEntityLabel` supplies live query data; tests supply fixtures.
 */
export function resolveTabLabel(
  tab: Pick<EntityTab, "kind" | "entityId" | "label">,
  sources: LabelSources
): EntityLabel {
  const fallback: EntityLabel = { primary: tab.label, enriched: false };

  switch (tab.kind) {
    case "task": {
      const row = sources.tasks.find((t) => t.id === tab.entityId);
      // Anchor + title: the mt#X anchor is load-bearing (cockpit-design
      // §entity IDs) and stays in the label for tasks.
      return row?.title ? { primary: `${tab.entityId} · ${row.title}`, enriched: true } : fallback;
    }
    case "agent": {
      const row = sources.agentRows.find((a) => a.sessionId === tab.entityId);
      if (row?.taskTitle) return { primary: row.taskTitle, enriched: true };
      if (row?.taskId) return { primary: row.taskId, enriched: true };
      return fallback;
    }
    case "session": {
      // Conversation tabs (kind "session" pending the broader tab-kind
      // rename — see tabs.tsx): the server-derived ladder label.
      const row = sources.conversationRows.find((c) => c.agentSessionId === tab.entityId);
      return row?.label ? { primary: row.label, enriched: true } : fallback;
    }
    case "ask": {
      const row = sources.askRows.find((a) => a.id === tab.entityId);
      return row?.title ? { primary: row.title, enriched: true } : fallback;
    }
    case "memory": {
      const row = sources.memoryRows.find((m) => m.id === tab.entityId);
      return row?.name ? { primary: row.name, enriched: true } : fallback;
    }
    case "changeset": {
      const n = Number(tab.entityId);
      const row = Number.isFinite(n)
        ? sources.changesetRows.find((c) => c.number === n)
        : undefined;
      return row?.title ? { primary: `#${n} · ${row.title}`, enriched: true } : fallback;
    }
    default:
      return fallback;
  }
}

// ---------------------------------------------------------------------------
// Extraction helpers (WidgetData → LabelSources slices)
// ---------------------------------------------------------------------------

function extractAgentRows(data: WidgetData | undefined): LabelSources["agentRows"] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as {
    agents?: { sessionId: string; taskId: string | null; taskTitle: string | null }[];
  };
  if (!Array.isArray(payload?.agents)) return [];
  return payload.agents.map((a) => ({
    sessionId: a.sessionId,
    taskId: a.taskId ?? null,
    taskTitle: a.taskTitle ?? null,
  }));
}

function extractAskRows(data: WidgetData | undefined): LabelSources["askRows"] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { cohort?: { id: string; title: string }[] };
  if (!Array.isArray(payload?.cohort)) return [];
  return payload.cohort.map((a) => ({ id: a.id, title: a.title }));
}

function extractMemoryRows(data: WidgetData | undefined): LabelSources["memoryRows"] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { records?: { id: string; name: string }[] };
  if (!Array.isArray(payload?.records)) return [];
  return payload.records.map((r) => ({ id: r.id, name: r.name }));
}

async function fetchChangesetRows(): Promise<LabelSources["changesetRows"]> {
  try {
    const res = await fetch("/api/changesets");
    if (!res.ok) return [];
    const data = (await res.json()) as {
      changesets?: { pr?: { number?: number | null; title?: string | null } }[];
    };
    if (!Array.isArray(data.changesets)) return [];
    return data.changesets.map((c) => ({
      number: c.pr?.number ?? null,
      title: c.pr?.title ?? null,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Resolve the display label for one entity tab. Only the query for the tab's
 * own kind is enabled; all keys are shared with existing surfaces so this
 * rides warm caches. Falls back to `tab.label` (the shortened id) until data
 * arrives — never blocks rendering.
 */
export function useEntityLabel(tab: Pick<EntityTab, "kind" | "entityId" | "label">): EntityLabel {
  const tasksQuery = useQuery({
    queryKey: TASK_INDEX_QUERY_KEY,
    queryFn: fetchTaskIndex,
    enabled: tab.kind === "task",
    staleTime: 60_000,
  });

  const agentsQuery = useQuery<WidgetData, Error>({
    queryKey: ["agents"],
    queryFn: () => fetchWidgetData("agents"),
    enabled: tab.kind === "agent",
    staleTime: 30_000,
  });

  const conversationsQuery = useQuery<WidgetData, Error>({
    queryKey: ["context-inspector", "sessions"],
    queryFn: () => fetchWidgetData("context-inspector"),
    enabled: tab.kind === "session",
    staleTime: 30_000,
  });

  const attentionQuery = useQuery<WidgetData, Error>({
    queryKey: ["attention"],
    queryFn: () => fetchWidgetData("attention"),
    enabled: tab.kind === "ask",
    staleTime: 30_000,
  });

  const memoriesQuery = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-list", "", "", true],
    queryFn: () => fetchWidgetData("memories-list", { excludeSuperseded: "true" }),
    enabled: tab.kind === "memory",
    staleTime: 60_000,
  });

  const changesetsQuery = useQuery({
    queryKey: ["changeset-label-index"],
    queryFn: fetchChangesetRows,
    enabled: tab.kind === "changeset",
    staleTime: 30_000,
  });

  return resolveTabLabel(tab, {
    tasks: tasksQuery.data ?? [],
    agentRows: extractAgentRows(agentsQuery.data),
    conversationRows: extractConversationRows(conversationsQuery.data),
    askRows: extractAskRows(attentionQuery.data),
    memoryRows: extractMemoryRows(memoriesQuery.data),
    changesetRows: changesetsQuery.data ?? [],
  });
}
