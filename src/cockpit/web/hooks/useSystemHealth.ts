/**
 * useSystemHealth — shared hook aggregating real health signals for three
 * plant-board surfaces (mt#2590):
 *
 *   - The header banner ("system nominal" / degraded / unknown).
 *   - The Infra Supply node's per-service dots (mcp server / postgres /
 *     credentials / embeddings). `reviewerBot` stays "unknown" — no HTTP
 *     surface exists today for minsky-reviewer[bot] health from the cockpit
 *     server (honest gap; see PR body).
 *   - The S4 deploy chip ("build -> smoke -> live"), reusing the
 *     `mcp-server-status` widget's already-computed `deploy.status` field
 *     (no new endpoint needed — mt#2590 constraint 2).
 *
 * Each source degrades INDEPENDENTLY: a failure in one does not blank the
 * others. Per the honest-fallback rule, "unknown" is a distinct rendered
 * state from "healthy" / "unhealthy" — never silently coerced to a color.
 *
 * Sources (all pre-existing; zero new server.ts routes):
 *   - GET /api/widget/basic-health/data — reachability probe only.
 *   - GET /api/widget/mcp-server-status/data — health.ok + deploy.status.
 *   - GET /api/widget/embeddings-health/data — status field.
 *   - GET /api/health — `db` field (Postgres connectivity, from the
 *     cockpit's own perspective).
 *   - GET /api/credentials — `configured` field per provider.
 *
 * Query key: ["plant-board", "system-health"]
 * staleTime: 10s, refetchInterval: 15s (fastest of the constituent widgets'
 * own polling intervals, so the plant board never lags behind any one source).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";

export type ServiceHealth = "healthy" | "unhealthy" | "unknown";
export type HeaderHealth = "nominal" | "degraded" | "unknown";

export interface SystemHealthSnapshot {
  header: HeaderHealth;
  infra: {
    mcpServer: ServiceHealth;
    postgres: ServiceHealth;
    credentials: ServiceHealth;
    embeddings: ServiceHealth;
    /** No HTTP surface exists today for reviewer-bot health (honest gap). */
    reviewerBot: ServiceHealth;
  };
  /** DeploymentStatus enum value (e.g. "SUCCESS", "FAILED"), or null if unreachable. */
  deployStatus: string | null;
}

// ---------------------------------------------------------------------------
// Frontend-local mirrors of server payload shapes (no server imports on the
// frontend, per the existing widget-frontend convention — see Attention.tsx).
// ---------------------------------------------------------------------------

interface McpServerStatusPayload {
  health: { ok: boolean };
  deploy: { status: string } | null;
}

interface EmbeddingsHealthPayload {
  status: "healthy" | "degraded" | "exhausted";
}

interface ApiHealthResponse {
  db: "ok" | "degraded" | "unreachable";
}

interface CredentialListing {
  provider: string;
  configured: boolean;
}

interface CredentialsResponse {
  credentials: CredentialListing[];
}

async function fetchSystemHealth(): Promise<SystemHealthSnapshot> {
  const [basicHealthResult, mcpResult, embeddingsResult, apiHealthResult, credentialsResult] =
    await Promise.allSettled([
      fetchWidgetData("basic-health"),
      fetchWidgetData("mcp-server-status"),
      fetchWidgetData("embeddings-health"),
      fetch("/api/health").then((r) => {
        if (!r.ok) throw new Error(`api/health: ${r.status}`);
        return r.json() as Promise<ApiHealthResponse>;
      }),
      fetch("/api/credentials").then((r) => {
        if (!r.ok) throw new Error(`api/credentials: ${r.status}`);
        return r.json() as Promise<CredentialsResponse>;
      }),
    ]);

  const basicHealthReachable =
    basicHealthResult.status === "fulfilled" && basicHealthResult.value.state === "ok";

  let mcpHealthy: ServiceHealth = "unknown";
  let deployStatus: string | null = null;
  if (mcpResult.status === "fulfilled" && mcpResult.value.state === "ok") {
    const payload = mcpResult.value.payload as McpServerStatusPayload;
    mcpHealthy = payload.health.ok ? "healthy" : "unhealthy";
    deployStatus = payload.deploy?.status ?? null;
  }

  let embeddingsHealthy: ServiceHealth = "unknown";
  if (embeddingsResult.status === "fulfilled" && embeddingsResult.value.state === "ok") {
    const payload = embeddingsResult.value.payload as EmbeddingsHealthPayload;
    embeddingsHealthy = payload.status === "healthy" ? "healthy" : "unhealthy";
  }

  let postgresHealthy: ServiceHealth = "unknown";
  if (apiHealthResult.status === "fulfilled") {
    postgresHealthy = apiHealthResult.value.db === "ok" ? "healthy" : "unhealthy";
  }

  let credentialsHealthy: ServiceHealth = "unknown";
  if (credentialsResult.status === "fulfilled") {
    const { credentials } = credentialsResult.value;
    credentialsHealthy =
      credentials.length > 0 && credentials.some((c) => c.configured) ? "healthy" : "unhealthy";
  }

  // Header derivation: unknown if we can't even confirm the cockpit API is
  // reachable; degraded if any known source reports unhealthy; else nominal.
  let header: HeaderHealth = "unknown";
  if (basicHealthReachable) {
    const anyUnhealthy = [mcpHealthy, embeddingsHealthy, postgresHealthy].includes("unhealthy");
    header = anyUnhealthy ? "degraded" : "nominal";
  }

  return {
    header,
    infra: {
      mcpServer: mcpHealthy,
      postgres: postgresHealthy,
      credentials: credentialsHealthy,
      embeddings: embeddingsHealthy,
      reviewerBot: "unknown",
    },
    deployStatus,
  };
}

export function useSystemHealth() {
  return useQuery({
    queryKey: ["plant-board", "system-health"],
    queryFn: fetchSystemHealth,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}
