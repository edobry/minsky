/**
 * useSlowTopology — shared hook for the plant board's slow-clock topology
 * (mt#2602): the S2 valve-inventory count badge and the weld-history
 * drill-down page both read this one hook.
 *
 * Data source: GET /api/widget/slow-topology/data — see
 * src/cockpit/widgets/slow-topology.ts for the payload shape and
 * src/cockpit/topology-derivation.ts for the derivation logic behind it.
 *
 * Query key: ["plant-board", "slow-topology"]
 * staleTime: 60s, refetchInterval: 5m (the server recomputes hourly; a
 * shorter frontend poll just keeps a freshly-opened board from lingering in
 * "pending" for the full hour after a cockpit restart).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";

export interface RetrospectiveLinkPayload {
  eventId: string;
  note: string | null;
  taskId: string | null;
  createdAt: string;
  matchType: "task-ref" | "time-proximity";
}

export interface WeldEntryPayload {
  name: string;
  sourceDir: ".minsky/hooks" | ".claude/hooks";
  installDate: string | null;
  commitSha: string | null;
  commitUrl: string | null;
  retrospective: RetrospectiveLinkPayload | null;
}

export interface SlowTopologyPayload {
  status: "pending" | "ready";
  computedAt: string | null;
  interlockCount: number;
  entries: WeldEntryPayload[];
}

async function fetchSlowTopology(): Promise<SlowTopologyPayload> {
  const data = await fetchWidgetData("slow-topology");
  if (data.state !== "ok") {
    throw new Error(`slow-topology widget: ${data.reason}`);
  }
  return data.payload as SlowTopologyPayload;
}

export function useSlowTopology() {
  return useQuery({
    queryKey: ["plant-board", "slow-topology"],
    queryFn: fetchSlowTopology,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}
