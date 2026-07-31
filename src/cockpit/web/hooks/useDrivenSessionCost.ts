/**
 * useDrivenSessionCost — cockpit readout hook for the mt#2753 (Rung 2D) cost
 * widget: per-session and aggregate driven-session spend/usage.
 *
 * Data source: GET /api/widget/driven-session-cost/data — see
 * ../../widgets/driven-session-cost.ts for the payload shape and aggregation
 * logic (per-turn rows rolled up per-session + globally, with a
 * daily/monthly spend projection at the observed cadence).
 *
 * Query key: ["driven-session-cost"]
 * staleTime: 30s, refetchInterval: 60s (matches the widget's own polling
 * cadence — a shorter frontend interval would just re-fetch identical data).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";
import type { DrivenSessionCostPayload } from "../../widgets/driven-session-cost";

export type {
  DrivenSessionCostPayload,
  DrivenSessionCostSessionSummary,
} from "../../widgets/driven-session-cost";

async function fetchDrivenSessionCost(): Promise<DrivenSessionCostPayload> {
  const data = await fetchWidgetData("driven-session-cost");
  if (data.state !== "ok") {
    throw new Error(`driven-session-cost widget: ${data.reason}`);
  }
  return data.payload as DrivenSessionCostPayload;
}

export function useDrivenSessionCost() {
  return useQuery({
    queryKey: ["driven-session-cost"],
    queryFn: fetchDrivenSessionCost,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
