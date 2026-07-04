/**
 * useDeployVitals — shared hook for the /vitals deploy loop card (mt#2601).
 *
 * Reuses the `mcp-server-status` widget's already-computed `deploy` field
 * (same source useSystemHealth.ts reads for its `deployStatus` string) but
 * surfaces the fuller object (status + lastDeployAt + commitHash) that
 * McpServerStatus.tsx already renders — no new server.ts route.
 *
 * Phase-level deploy detail (build -> smoke -> live sub-stages) is an honest
 * gap: no `deploy.*` event stream exists yet (arrives with mt#2537). Callers
 * must not synthesize phase progress from this hook's fields.
 *
 * Query key: ["vitals", "deploy"]
 * staleTime: 10s, refetchInterval: 15s (matches useSystemHealth's cadence —
 * both read the same underlying widget poll).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";

// Mirrors DeploymentStatus in src/cockpit/widgets/mcp-server-status.ts /
// McpServerStatus.tsx. Frontend-local per the no-server-imports-on-the-
// frontend convention.
export type DeploymentStatus =
  | "BUILDING"
  | "DEPLOYING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "CRASHED"
  | "UNKNOWN";

export interface DeployVitalsSnapshot {
  status: DeploymentStatus;
  lastDeployAt: string | null;
  commitHash: string | null;
}

interface McpServerStatusPayload {
  deploy: {
    commitHash: string | null;
    commitMessage: string | null;
    lastDeployAt: string | null;
    status: DeploymentStatus;
  } | null;
}

async function fetchDeployVitals(): Promise<DeployVitalsSnapshot> {
  const data = await fetchWidgetData("mcp-server-status");
  if (data.state !== "ok") {
    throw new Error(`mcp-server-status widget: ${data.reason}`);
  }
  const payload = data.payload as McpServerStatusPayload;
  return {
    status: payload.deploy?.status ?? "UNKNOWN",
    lastDeployAt: payload.deploy?.lastDeployAt ?? null,
    commitHash: payload.deploy?.commitHash ?? null,
  };
}

export function useDeployVitals() {
  return useQuery({
    queryKey: ["vitals", "deploy"],
    queryFn: fetchDeployVitals,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}
