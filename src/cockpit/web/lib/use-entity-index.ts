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
 * @see entity-linkifier.tsx — the tokenizer + rehype plugin that consume the index
 * @see mt#2518 — original linkifier; mt#2550 — Markdown rendering that reuses this
 */
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { buildEntityIndex, type EntityIndex } from "./entity-linkifier";
import { fetchWidgetData, type WidgetData } from "./widget-client";

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

function extractAskIds(data: WidgetData | undefined): string[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { cohort?: { id: string }[] };
  if (!Array.isArray(payload?.cohort)) return [];
  return payload.cohort.map((a) => a.id);
}

function extractMemoryIds(data: WidgetData | undefined): string[] {
  if (!data || data.state !== "ok") return [];
  const payload = data.payload as { records?: { id: string }[] };
  if (!Array.isArray(payload?.records)) return [];
  return payload.records.map((r) => r.id);
}

/**
 * Build the entity index from data fetched for linkification purposes.
 * Returns an always-present EntityIndex (may be empty on load or error).
 */
export function useEntityIndex(): EntityIndex {
  const [tasksQ, agentsQ, attentionQ, memoriesQ] = useQueries({
    queries: [
      {
        // Distinct key from CommandPalette's "command-palette-tasks" — different shape
        // (string[] here via /api/tasks/ids vs PaletteTask[] there; sharing would
        // poison the cache). Uses the uncapped ids-only endpoint (mt#2518 R5) so the
        // id-set is comprehensive — no 500-task cap.
        queryKey: ["entity-index", "tasks"],
        queryFn: fetchAllTaskIds,
        staleTime: 30_000,
      },
      {
        queryKey: ["agents"],
        queryFn: () => fetchWidgetData("agents"),
        staleTime: 30_000,
      },
      {
        queryKey: ["attention"],
        queryFn: () => fetchWidgetData("attention"),
        staleTime: 30_000,
      },
      {
        queryKey: ["widget", "memories-list", "", "", true],
        queryFn: () => fetchWidgetData("memories-list", { excludeSuperseded: "true" }),
        staleTime: 30_000,
      },
    ],
  });

  return useMemo(
    () =>
      buildEntityIndex({
        taskIds: (tasksQ.data as string[] | undefined) ?? [],
        sessionIds: extractAgentSessionIds(agentsQ.data as WidgetData | undefined),
        askIds: extractAskIds(attentionQ.data as WidgetData | undefined),
        memoryIds: extractMemoryIds(memoriesQ.data as WidgetData | undefined),
      }),
    [tasksQ.data, agentsQ.data, attentionQ.data, memoriesQ.data]
  );
}
