/**
 * useReadyCount — shared hook for the READY task count.
 *
 * Lifted from the (retired, mt#2423) SVG PlantPage so plant-board variants
 * could share it; now consumed by PlantFlowPage (the /plant board).
 *
 * Query key: ["plant-board", "ready-count"]
 * staleTime: 30s, refetchInterval: 60s (breath-clock cadence).
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

async function fetchReadyTaskCount(): Promise<number> {
  const res = await fetch("/api/tasks");
  if (!res.ok) throw new Error(`tasks API: ${res.status}`);
  const body = (await res.json()) as TaskListResponse;
  return body.tasks.filter((t) => t.status === "READY").length;
}

export function useReadyCount() {
  return useQuery({
    queryKey: ["plant-board", "ready-count"],
    queryFn: fetchReadyTaskCount,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
