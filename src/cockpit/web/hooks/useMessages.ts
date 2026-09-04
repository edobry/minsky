/**
 * useMessages — cockpit readout hook for the mt#4874 Messages page.
 *
 * Data source: GET /api/widget/messages/data — see ../../widgets/messages.ts
 * for the payload shape, the two query paths behind it, and the coverage
 * accounting it reports.
 *
 * IMPORTS ONLY A TYPE from the widget module, and that is load-bearing rather
 * than incidental. `../../widgets/messages` reaches db-providers.ts, which is
 * Node-only (`process.env`, `@minsky/domain/persistence`); a VALUE import of
 * anything from it would pull that whole graph into the Vite client bundle and
 * crash the page at runtime with "process is not defined" — invisible to
 * component tests, since bun's test DOM has `process` defined and a real
 * browser does not. That is mt#3348 R2, which cost PR #3348 a Dockerfile change
 * to repair. `import type` is erased at build time and pulls nothing, which is
 * why the sibling `useDrivenSessionCost` has done exactly this for months
 * without one. Anything both sides need as a VALUE belongs in
 * `@minsky/domain/transcripts/peer-message-correlation`, which is deliberately
 * dependency-free.
 *
 * Query key: ["messages"]
 * staleTime: 30s, refetchInterval: 60s (matches the widget's own polling
 * cadence — a shorter frontend interval would just re-fetch identical data).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";
import type { MessagesPayload } from "../../widgets/messages";

export type { MessagesPayload, MessagesCoverage } from "../../widgets/messages";

async function fetchMessages(): Promise<MessagesPayload> {
  const data = await fetchWidgetData("messages");
  if (data.state !== "ok") {
    throw new Error(`messages widget: ${data.reason}`);
  }
  return data.payload as MessagesPayload;
}

export function useMessages() {
  return useQuery({
    queryKey: ["messages"],
    queryFn: fetchMessages,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
