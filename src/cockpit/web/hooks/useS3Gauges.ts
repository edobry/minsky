/**
 * useS3Gauges — shared hook for the S3 · Management node's three mini-gauge
 * instruments (mt#2590).
 *
 * Data source: GET /api/widget/s3-gauges/data — see
 * src/cockpit/widgets/s3-gauges.ts for the exact predicates/queries behind
 * each field (mirrors the CLAUDE.md "MCP disconnect cadence" and "Subagent
 * dispatch cadence" escalation rules).
 *
 * Query key: ["plant-board", "s3-gauges"]
 * staleTime: 15s, refetchInterval: 30s (matches the server widget's own
 * polling interval).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";

export interface S3GaugesPayload {
  mcpDisconnects: { eligibleCount24h: number | null; threshold: number };
  subagentDispatches: { partialUncommittedCount: number | null; threshold: number };
  attention: { value: null };
}

async function fetchS3Gauges(): Promise<S3GaugesPayload> {
  const data = await fetchWidgetData("s3-gauges");
  if (data.state !== "ok") {
    throw new Error(`s3-gauges widget: ${data.reason}`);
  }
  return data.payload as S3GaugesPayload;
}

export function useS3Gauges() {
  return useQuery({
    queryKey: ["plant-board", "s3-gauges"],
    queryFn: fetchS3Gauges,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/**
 * Scale a real count against its CLAUDE.md-documented escalation threshold
 * onto the MiniGaugeArc's 0..1 fraction space, with the setpoint fixed at the
 * midpoint (0.5) and the threshold value sitting there — so the needle
 * crossing the setpoint mark visually means "over threshold," matching the
 * gauge's alarm-setpoint semantics.
 */
export function gaugeFraction(count: number | null, threshold: number): number {
  if (count === null) return 0;
  const scaleMax = threshold * 2;
  return Math.min(1, count / scaleMax);
}

export const GAUGE_SETPOINT_FRACTION = 0.5;
