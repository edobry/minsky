#!/usr/bin/env bun
/**
 * scripts/railway/status.ts
 *
 * Lists the N most recent deployments for a Railway service.
 *
 * Usage:
 *   bun scripts/railway/status.ts --config <path-to-service-dir> [options]
 *   bun scripts/railway/status.ts --service-id <id> [options]
 *
 * Options:
 *   --config <dir>       Path to a directory containing railway.config.ts (reads serviceId)
 *   --service-id <id>    Raw Railway service ID (alternative to --config)
 *   --limit N            Number of recent deploys to show (default: 5)
 *   --json               Output raw JSON instead of formatted table
 *   --help               Show this help message
 *
 * Exit codes:
 *   0  Success
 *   1  Auth / config error
 *   2  API error
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RailwayConfig } from "./lib";
import { safeTruncate } from "../../src/utils/safe-truncate";

// Canonical Railway auth + GraphQL primitives — mt#2013 consolidated the
// previous local duplicates of readRailwayToken / RAILWAY_GRAPHQL_URL /
// AuthError / ApiError / graphql<T>() through this module. All Railway HTTP
// traffic now flows through src/domain/deployment/railway/graphql-client.ts
// and inherits OAuth token-refresh via getValidRailwayToken.
import {
  RailwayAuthError,
  RailwayApiError,
  getValidRailwayToken,
  railwayGraphQL,
} from "@minsky/domain/deployment/railway/graphql-client";

// Re-export under historical script-side names so the existing test surface
// (`status.test.ts` imports AuthError/ApiError from this module) keeps working.
// AuthError === RailwayAuthError (instanceof / catch). The error's `.name`
// field reflects the canonical class name ("RailwayAuthError" / "RailwayApiError").
export {
  RailwayAuthError as AuthError,
  RailwayApiError as ApiError,
} from "@minsky/domain/deployment/railway/graphql-client";

const DEFAULT_LIMIT = 5;

// --- GraphQL client (thin wrapper preserving the pre-mt#2013 signature) ---

/**
 * Token-by-arg GraphQL helper. Preserved for back-compat with `fetchDeployments`
 * and the test surface; new callers should use `railwayGraphQL` or
 * `railwayGraphQLAuthed` from the canonical module directly.
 */
export async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string
): Promise<T> {
  return railwayGraphQL<T>(query, variables, token);
}

// --- Types ---

export type DeploymentMeta = {
  commitHash?: string;
  commitMessage?: string;
  [key: string]: unknown;
};

export type DeploymentNode = {
  id: string;
  status: string;
  createdAt: string;
  meta?: DeploymentMeta | null;
};

type DeploymentsResponse = {
  service: {
    deployments: {
      edges: {
        node: DeploymentNode;
      }[];
    };
  };
};

// --- Queries ---

const SERVICE_DEPLOYMENTS_QUERY = `
  query ($serviceId: String!, $limit: Int!) {
    service(id: $serviceId) {
      deployments(first: $limit) {
        edges {
          node {
            id
            status
            createdAt
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
): Promise<DeploymentNode[]> {
  const data = await graphql<DeploymentsResponse>(
    SERVICE_DEPLOYMENTS_QUERY,
    { serviceId, limit },
    token
  );
  return data.service.deployments.edges.map((e) => e.node);
}

// --- Formatting ---

const NON_SUCCESS_STATUSES = new Set(["CRASHED", "FAILED", "BUILDING", "ERROR"]);

export function formatDeploymentsTable(deployments: DeploymentNode[]): string {
  if (deployments.length === 0) {
    return "(no deployments found)";
  }

  const lines: string[] = [];
  for (const d of deployments) {
    const commitHash = d.meta?.commitHash?.slice(0, 8) ?? "(none)";
    const rawMessage = d.meta?.commitMessage ?? "";
    const commitMessage =
      rawMessage.length > 60 ? `${safeTruncate(rawMessage, 60, "head")}...` : rawMessage;
    const statusLabel = NON_SUCCESS_STATUSES.has(d.status) ? `[${d.status}]` : d.status;
    lines.push(
      `${statusLabel.padEnd(12)} ${d.createdAt}  ${d.id}  ${commitHash}  ${commitMessage}`
    );
  }
  return lines.join("\n");
}

// --- Config loading ---

export async function loadServiceId(configDir: string): Promise<string> {
  const configPath = resolve(configDir, "railway.config.ts");
  if (!existsSync(configPath)) {
    throw new RailwayAuthError(`No railway.config.ts found at: ${configPath}`);
  }
  let mod: { default?: RailwayConfig } | RailwayConfig;
  try {
    mod = (await import(pathToFileURL(configPath).href)) as typeof mod;
  } catch (err) {
    throw new RailwayAuthError(
      `Failed to load railway.config.ts from ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  const config =
    mod && typeof mod === "object" && "default" in mod && mod.default != null
      ? mod.default
      : (mod as RailwayConfig);
  if (!config || typeof config !== "object" || !("serviceId" in config)) {
    throw new RailwayAuthError(
      `railway.config.ts at ${configPath} must export a valid RailwayConfig as the default export`
    );
  }
  return config.serviceId;
}

// --- Arg parsing ---

export type StatusArgs = {
  serviceId: string;
  limit: number;
  json: boolean;
};

export function parseArgs(argv: string[]): StatusArgs {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const configIdx = args.indexOf("--config");
  const serviceIdIdx = args.indexOf("--service-id");
  const limitIdx = args.indexOf("--limit");
  const jsonFlag = args.includes("--json");

  let serviceId: string | undefined;
  let configDir: string | undefined;

  if (configIdx !== -1) {
    configDir = args[configIdx + 1];
    if (!configDir || configDir.startsWith("--")) {
      printUsageError("--config requires a path argument");
    }
  }

  if (serviceIdIdx !== -1) {
    serviceId = args[serviceIdIdx + 1];
    if (!serviceId || serviceId.startsWith("--")) {
      printUsageError("--service-id requires an ID argument");
    }
  }

  if (!configDir && !serviceId) {
    printUsageError("Either --config <dir> or --service-id <id> is required");
  }

  let limit = DEFAULT_LIMIT;
  if (limitIdx !== -1) {
    const limitStr = args[limitIdx + 1];
    if (!limitStr || limitStr.startsWith("--")) {
      printUsageError("--limit requires a number argument");
    }
    limit = parseInt(limitStr, 10);
    if (isNaN(limit) || limit < 1) {
      printUsageError(`--limit must be a positive integer, got: ${limitStr}`);
    }
  }

  // configDir will be resolved to a serviceId at runtime (async)
  // We store it in serviceId as a placeholder; the main function resolves it.
  return {
    serviceId: serviceId ?? configDir ?? "",
    limit,
    json: jsonFlag,
  };
}

function printUsage(): void {
  console.error(
    "Usage: bun scripts/railway/status.ts --config <dir> | --service-id <id> [options]"
  );
  console.error("");
  console.error("Options:");
  console.error("  --config <dir>       Path to directory containing railway.config.ts");
  console.error("  --service-id <id>    Raw Railway service ID");
  console.error("  --limit N            Number of recent deploys to show (default: 5)");
  console.error("  --json               Output raw JSON");
  console.error("  --help               Show this message");
}

function printUsageError(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error("");
  printUsage();
  process.exit(1);
}

// --- Main ---

async function run(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const configIdx = rawArgs.indexOf("--config");
  const serviceIdIdx = rawArgs.indexOf("--service-id");
  const limitIdx = rawArgs.indexOf("--limit");
  const jsonFlag = rawArgs.includes("--json");

  let serviceId: string | undefined;

  if (configIdx !== -1) {
    const configDir = rawArgs[configIdx + 1];
    if (!configDir || configDir.startsWith("--")) {
      printUsageError("--config requires a path argument");
    }
    try {
      serviceId = await loadServiceId(configDir);
    } catch (err) {
      if (err instanceof RailwayAuthError) {
        console.error(`Auth/config error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  } else if (serviceIdIdx !== -1) {
    serviceId = rawArgs[serviceIdIdx + 1];
    if (!serviceId || serviceId.startsWith("--")) {
      printUsageError("--service-id requires an ID argument");
    }
  } else {
    printUsageError("Either --config <dir> or --service-id <id> is required");
  }

  let limit = DEFAULT_LIMIT;
  if (limitIdx !== -1) {
    const limitStr = rawArgs[limitIdx + 1];
    if (!limitStr || limitStr.startsWith("--")) {
      printUsageError("--limit requires a number argument");
    }
    limit = parseInt(limitStr, 10);
    if (isNaN(limit) || limit < 1) {
      printUsageError(`--limit must be a positive integer, got: ${limitStr}`);
    }
  }

  let token: string;
  try {
    token = await getValidRailwayToken();
  } catch (err) {
    if (err instanceof RailwayAuthError) {
      console.error(`Auth error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  let deployments: DeploymentNode[];
  try {
    deployments = await fetchDeployments(serviceId, limit, token);
  } catch (err) {
    if (err instanceof RailwayApiError) {
      console.error(`API error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  if (jsonFlag) {
    console.log(JSON.stringify(deployments, null, 2));
  } else {
    console.log(formatDeploymentsTable(deployments));
  }
}

// Only run when invoked directly, not when imported as a module (e.g., by tests)
if (import.meta.main) {
  run().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Unexpected error: ${message}`);
    process.exit(2);
  });
}
