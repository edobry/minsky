/**
 * useWorkLoopCounts — shared hook for the /vitals "work loop" card (mt#2601).
 *
 * Extends the mt#2590 data-layer pattern (see useReadyCount.ts,
 * useTaskBacklogCounts.ts): same `/api/tasks` source, same fetch shape, but
 * counts the three statuses the work loop needs (READY / IN-PROGRESS /
 * IN-REVIEW) in one round-trip rather than three separate hooks polling the
 * same endpoint independently.
 *
 * Query key: ["vitals", "work-loop-counts"]
 * staleTime: 30s, refetchInterval: 60s (breath-clock cadence, matching
 * useReadyCount / useTaskBacklogCounts).
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

export interface WorkLoopCounts {
  ready: number;
  inProgress: number;
  inReview: number;
}

async function fetchWorkLoopCounts(): Promise<WorkLoopCounts> {
  const res = await fetch("/api/tasks");
  if (!res.ok) throw new Error(`tasks API: ${res.status}`);
  const body = (await res.json()) as TaskListResponse;
  let ready = 0;
  let inProgress = 0;
  let inReview = 0;
  for (const t of body.tasks) {
    if (t.status === "READY") ready++;
    else if (t.status === "IN-PROGRESS") inProgress++;
    else if (t.status === "IN-REVIEW") inReview++;
  }
  return { ready, inProgress, inReview };
}

export function useWorkLoopCounts() {
  return useQuery({
    queryKey: ["vitals", "work-loop-counts"],
    queryFn: fetchWorkLoopCounts,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
