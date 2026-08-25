/**
 * useReviewerCost — cockpit readout hook for the mt#4557 reviewer-cost page.
 *
 * Data source: GET /api/widget/reviewer-cost/data — see
 * ../../widgets/reviewer-cost.ts for the payload shape. As of this writing
 * that widget's fetch() always resolves `degraded` (blocked on mt#4546's
 * review_timing accessor — see ask#10301); this hook surfaces that as a
 * thrown error like every other degraded widget, so the page's isError
 * branch — not a zero-filled happy path — is what renders today.
 *
 * Query key: ["reviewer-cost"]
 * staleTime: 30s, refetchInterval: 60s (matches the widget's own polling
 * cadence, same as useDrivenSessionCost).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";
import type { ReviewerCostPayload } from "../../widgets/reviewer-cost";

export type {
  ReviewerCostPayload,
  ReviewerCostDailyBucket,
  ReviewerCostCohortRow,
  ReviewerCostOutlierEntry,
} from "../../widgets/reviewer-cost";

async function fetchReviewerCost(): Promise<ReviewerCostPayload> {
  const data = await fetchWidgetData("reviewer-cost");
  if (data.state !== "ok") {
    throw new Error(`reviewer-cost widget: ${data.reason}`);
  }
  return data.payload as ReviewerCostPayload;
}

export function useReviewerCost() {
  return useQuery({
    queryKey: ["reviewer-cost"],
    queryFn: fetchReviewerCost,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
