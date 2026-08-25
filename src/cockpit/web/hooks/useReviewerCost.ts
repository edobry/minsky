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
 * TWO DISTINCT throw shapes (mt#3348 R1, reviewer-bot BLOCKING finding): a
 * page that renders one generic "error" for both "this feature isn't wired
 * up yet" and "a live query just failed" gives an operator no way to tell
 * them apart — the first is expected and permanent until mt#4546 ships, the
 * second is a real incident. `ReviewerCostNotYetAvailableError` is thrown
 * for the KNOWN not-yet-wired reason (matched via
 * `NOT_YET_WIRED_REASON_PREFIX`, the widget's own stable marker); anything
 * else — including a genuine accessor failure once mt#4546 lands — throws a
 * plain `Error`, so the page's error branch stays reserved for real failures.
 *
 * IMPORTS FROM ../../widgets/reviewer-cost-contract, NOT ./reviewer-cost
 * (mt#3348 R2): the widget module (reviewer-cost.ts) imports db-providers.ts,
 * a Node-only module (process.env, @minsky/domain/persistence). A VALUE
 * import of anything from reviewer-cost.ts here would pull that whole
 * dependency graph into the Vite CLIENT bundle and crash the page at
 * runtime with "process is not defined" — invisible to component tests,
 * since bun's test DOM has `process` defined and a real browser doesn't.
 * The contract module is dependency-free specifically so both sides can
 * import it safely.
 *
 * Query key: ["reviewer-cost"]
 * staleTime: 30s, refetchInterval: 60s (matches the widget's own polling
 * cadence, same as useDrivenSessionCost).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";
import { NOT_YET_WIRED_REASON_PREFIX } from "../../widgets/reviewer-cost-contract";
import type { ReviewerCostPayload } from "../../widgets/reviewer-cost-contract";

export type {
  ReviewerCostPayload,
  ReviewerCostDailyBucket,
  ReviewerCostCohortRow,
  ReviewerCostOutlierEntry,
} from "../../widgets/reviewer-cost-contract";

/** Thrown when the widget's degraded reason is the KNOWN "mt#4546 isn't
 * wired yet" case, not a live query failure. The page renders this as a
 * neutral "not yet available" notice rather than an urgent error. */
export class ReviewerCostNotYetAvailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ReviewerCostNotYetAvailableError";
  }
}

async function fetchReviewerCost(): Promise<ReviewerCostPayload> {
  const data = await fetchWidgetData("reviewer-cost");
  if (data.state !== "ok") {
    if (data.reason.startsWith(NOT_YET_WIRED_REASON_PREFIX)) {
      throw new ReviewerCostNotYetAvailableError(data.reason);
    }
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
