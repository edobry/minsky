/**
 * Railway GraphQL client primitives — shared between the v1
 * RailwayDeploymentAdapter and the existing scripts/railway/ bun scripts.
 *
 * Extracted from scripts/railway/status.ts and scripts/railway/logs.ts as
 * part of mt#1730. The bun scripts will continue to re-export these
 * primitives (via scripts/railway/lib.ts) so behavior on that surface is
 * unchanged.
 *
 * Tracking task: mt#1730.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const GRAPHQL_TIMEOUT_MS = 30_000;

export class RailwayAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RailwayAuthError";
  }
}

export class RailwayApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RailwayApiError";
  }
}

/**
 * Read the Railway bearer token from `~/.railway/config.json`. Same path
 * the `railway` CLI populates; auth flow is `railway login`.
 */
export function readRailwayToken(): string {
  const cfgPath = join(homedir(), ".railway", "config.json");
  if (!existsSync(cfgPath)) {
    throw new RailwayAuthError(
      "Railway CLI is not authenticated (missing ~/.railway/config.json). Run: railway login"
    );
  }
  let cfg: { user?: { accessToken?: string } };
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf-8").toString()) as typeof cfg;
  } catch (err) {
    throw new RailwayAuthError(
      `Failed to parse ~/.railway/config.json: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  const token = cfg.user?.accessToken;
  if (!token) {
    throw new RailwayAuthError(
      "Railway CLI is not authenticated (no user.accessToken in ~/.railway/config.json). Run: railway login"
    );
  }
  return token;
}

/**
 * Execute a Railway GraphQL query. Throws RailwayApiError on HTTP errors,
 * parse failures, or GraphQL error responses.
 */
export async function railwayGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RailwayApiError(`Railway API request timed out after ${GRAPHQL_TIMEOUT_MS}ms`);
    }
    throw new RailwayApiError(
      `Railway API network error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const bodyText = await res.text();

  if (!res.ok) {
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- Railway API HTTP error body is ASCII
    const truncated = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
    throw new RailwayApiError(
      `Railway API request failed: HTTP ${res.status} ${res.statusText}. ` +
        `Body: ${truncated}. ` +
        `Check your Railway token and network connectivity.`
    );
  }

  let body: { data?: T; errors?: { message?: string; path?: (string | number)[] }[] };
  try {
    body = JSON.parse(bodyText) as typeof body;
  } catch (parseErr) {
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- Railway API HTTP error body is ASCII
    const truncated = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
    throw new RailwayApiError(
      `Railway API returned non-JSON response (HTTP ${res.status}): ${truncated}`,
      { cause: parseErr }
    );
  }

  if (body.errors) {
    const summary = body.errors
      .map((e) => {
        const path = e.path ? ` at ${e.path.join(".")}` : "";
        return `${e.message ?? "unknown GraphQL error"}${path}`;
      })
      .join("; ");
    throw new RailwayApiError(`GraphQL error: ${summary}`);
  }
  if (!body.data) {
    throw new RailwayApiError(`GraphQL returned no data for query: ${query.slice(0, 80)}`);
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Deployment listing
// ---------------------------------------------------------------------------

export interface RailwayDeploymentMeta {
  commitHash?: string;
  commitMessage?: string;
  [key: string]: unknown;
}

export interface RailwayDeploymentNode {
  id: string;
  status: string;
  createdAt: string;
  meta?: RailwayDeploymentMeta | null;
  staticUrl?: string | null;
}

interface DeploymentsResponse {
  service: {
    deployments: {
      edges: {
        node: RailwayDeploymentNode;
      }[];
    };
  };
}

const SERVICE_DEPLOYMENTS_QUERY = `
  query ($serviceId: String!, $limit: Int!) {
    service(id: $serviceId) {
      deployments(first: $limit) {
        edges {
          node {
            id
            status
            createdAt
            staticUrl
            meta
          }
        }
      }
    }
  }
`;

export async function fetchDeployments(
  serviceId: string,
  limit: number,
  token: string
): Promise<RailwayDeploymentNode[]> {
  const data = await railwayGraphQL<DeploymentsResponse>(
    SERVICE_DEPLOYMENTS_QUERY,
    { serviceId, limit },
    token
  );
  return data.service.deployments.edges.map((e) => e.node);
}

interface DeploymentByIdResponse {
  deployment: RailwayDeploymentNode | null;
}

const DEPLOYMENT_BY_ID_QUERY = `
  query ($deploymentId: String!) {
    deployment(id: $deploymentId) {
      id
      status
      createdAt
      staticUrl
      meta
    }
  }
`;

/**
 * Fetch a specific deployment by ID. Used to poll the targeted deployment
 * during waitForLatestDeployment so we don't depend on it remaining in the
 * recent-N service deployments window. Returns null when the deployment
 * does not exist.
 */
export async function fetchDeploymentById(
  deploymentId: string,
  token: string
): Promise<RailwayDeploymentNode | null> {
  const data = await railwayGraphQL<DeploymentByIdResponse>(
    DEPLOYMENT_BY_ID_QUERY,
    { deploymentId },
    token
  );
  return data.deployment;
}

// ---------------------------------------------------------------------------
// Deployment logs
// ---------------------------------------------------------------------------

export interface RailwayLogEntry {
  message: string;
  timestamp: string;
  severity: string;
}

interface DeploymentLogsResponse {
  deploymentLogs: RailwayLogEntry[];
}

interface BuildLogsResponse {
  buildLogs: RailwayLogEntry[];
}

const DEPLOYMENT_LOGS_QUERY = `
  query ($deploymentId: String!, $limit: Int!) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
      message
      timestamp
      severity
    }
  }
`;

const BUILD_LOGS_QUERY = `
  query ($deploymentId: String!, $limit: Int!) {
    buildLogs(deploymentId: $deploymentId, limit: $limit) {
      message
      timestamp
      severity
    }
  }
`;

export async function fetchDeploymentLogs(
  deploymentId: string,
  limit: number,
  token: string
): Promise<RailwayLogEntry[]> {
  const data = await railwayGraphQL<DeploymentLogsResponse>(
    DEPLOYMENT_LOGS_QUERY,
    { deploymentId, limit },
    token
  );
  return data.deploymentLogs;
}

export async function fetchBuildLogs(
  deploymentId: string,
  limit: number,
  token: string
): Promise<RailwayLogEntry[]> {
  const data = await railwayGraphQL<BuildLogsResponse>(
    BUILD_LOGS_QUERY,
    { deploymentId, limit },
    token
  );
  return data.buildLogs;
}
