/**
 * useTaskBacklogCounts — shared hook for the S4 backlog feed tank's TODO /
 * PLANNING counts (mt#2590).
 *
 * Mirrors useReadyCount.ts (same /api/tasks source, same shape), but counts
 * the two upstream statuses instead of READY. Kept as a separate hook (rather
 * than folding into useReadyCount) to keep each hook's query key + fetch
 * scoped to exactly what it renders, matching the existing one-hook-per-metric
 * convention on this board.
 *
 * Query key: ["plant-board", "backlog-counts"]
 * staleTime: 30s, refetchInterval: 60s (breath-clock cadence, matching useReadyCount).
 */
import { useQuery } from "@tanstack/react-query";

interface TaskListItem {
  id: string;
  title: string;
  status: string;
}

interface TaskListResponse {
  tasks: TaskListItem[];
}

export interface BacklogCounts {
  todo: number;
  planning: number;
}

async function fetchBacklogCounts(): Promise<BacklogCounts> {
  const res = await fetch("/api/tasks");
  if (!res.ok) throw new Error(`tasks API: ${res.status}`);
  const body = (await res.json()) as TaskListResponse;
  let todo = 0;
  let planning = 0;
  for (const t of body.tasks) {
    if (t.status === "TODO") todo++;
    else if (t.status === "PLANNING") planning++;
  }
  return { todo, planning };
}

export function useTaskBacklogCounts() {
  return useQuery({
    queryKey: ["plant-board", "backlog-counts"],
    queryFn: fetchBacklogCounts,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
