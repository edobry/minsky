/**
 * useWorkLoopCounts — shared hook for the /vitals "work loop" card (mt#2601).
 *
 * Extends the mt#2590 data-layer pattern (see useReadyCount.ts,
 * useTaskBacklogCounts.ts): same `/api/tasks` source, same fetch shape, but
 * counts the three statuses the work loop needs (READY / IN-PROGRESS /
 * IN-REVIEW) in one round-trip rather than three separate hooks polling the
 * same endpoint independently.
 *
 * Query key: ["vitals", "work-loop-counts", selectedSlug] (mt#4731 —
 * selectedSlug in the key so switching projects invalidates and refetches).
 * staleTime: 30s, refetchInterval: 60s (breath-clock cadence, matching
 * useReadyCount / useTaskBacklogCounts).
 */
import { useQuery } from "@tanstack/react-query";
import { useProject } from "../lib/project-context";

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

async function fetchWorkLoopCounts(queryParam?: { project: string }): Promise<WorkLoopCounts> {
  const qs = queryParam ? `?project=${encodeURIComponent(queryParam.project)}` : "";
  const res = await fetch(`/api/tasks${qs}`);
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
  const { selectedSlug, queryParam } = useProject();
  return useQuery({
    queryKey: ["vitals", "work-loop-counts", selectedSlug],
    queryFn: () => fetchWorkLoopCounts(queryParam),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
