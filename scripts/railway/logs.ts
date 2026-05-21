#!/usr/bin/env bun
/**
 * scripts/railway/logs.ts
 *
 * Fetches log lines for a Railway deployment by deployment ID.
 *
 * Usage:
 *   bun scripts/railway/logs.ts --deployment <id> [options]
 *
 * Options:
 *   --deployment <id>    Deployment ID (required)
 *   --limit N            Maximum number of log lines to fetch (default: 100)
 *   --severity <level>   Filter to a specific severity (error, warn, info, etc.)
 *   --grep <pattern>     Substring filter on the log message
 *   --json               Output raw JSON instead of formatted lines
 *   --help               Show this help message
 *
 * Exit codes:
 *   0  Success
 *   1  Auth / config error
 *   2  API error
 */
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
} from "../../src/domain/deployment/railway/graphql-client";

// Re-export under historical script-side names so the existing test surface
// (`logs.test.ts` imports AuthError/ApiError from this module) keeps working.
// AuthError === RailwayAuthError (instanceof / catch). The error's `.name`
// field reflects the canonical class name ("RailwayAuthError" / "RailwayApiError").
export {
  RailwayAuthError as AuthError,
  RailwayApiError as ApiError,
} from "../../src/domain/deployment/railway/graphql-client";

const DEFAULT_LIMIT = 100;

// --- GraphQL client (thin wrapper preserving the pre-mt#2013 signature) ---

/**
 * Token-by-arg GraphQL helper. Preserved for back-compat with `fetchDeploymentLogs`
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

export type LogEntry = {
  message: string;
  timestamp: string;
  severity: string;
};

type DeploymentLogsResponse = {
  deploymentLogs: LogEntry[];
};

// --- Query ---

const DEPLOYMENT_LOGS_QUERY = `
  query ($deploymentId: String!, $limit: Int!) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
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
): Promise<LogEntry[]> {
  const data = await graphql<DeploymentLogsResponse>(
    DEPLOYMENT_LOGS_QUERY,
    { deploymentId, limit },
    token
  );
  return data.deploymentLogs;
}

// --- Filtering ---

export function filterLogs(
  logs: LogEntry[],
  severity: string | undefined,
  grep: string | undefined
): LogEntry[] {
  let result = logs;
  if (severity) {
    const lowerSeverity = severity.toLowerCase();
    result = result.filter((l) => l.severity.toLowerCase() === lowerSeverity);
  }
  if (grep) {
    result = result.filter((l) => l.message.includes(grep));
  }
  return result;
}

// --- Formatting ---

export function formatLogLine(entry: LogEntry): string {
  return `${entry.timestamp} [${entry.severity}] ${entry.message}`;
}

export function formatLogsOutput(logs: LogEntry[]): string {
  if (logs.length === 0) {
    return "(no log lines matched)";
  }
  return logs.map(formatLogLine).join("\n");
}

// --- Arg parsing ---

export type LogsArgs = {
  deploymentId: string;
  limit: number;
  severity: string | undefined;
  grep: string | undefined;
  json: boolean;
};

function printUsage(): void {
  console.error("Usage: bun scripts/railway/logs.ts --deployment <id> [options]");
  console.error("");
  console.error("Options:");
  console.error("  --deployment <id>    Deployment ID (required)");
  console.error("  --limit N            Max log lines to fetch (default: 100)");
  console.error("  --severity <level>   Filter by severity (error, warn, info, etc.)");
  console.error("  --grep <pattern>     Substring filter on message");
  console.error("  --json               Output raw JSON");
  console.error("  --help               Show this message");
}

function printUsageError(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error("");
  printUsage();
  process.exit(1);
}

export function parseArgs(argv: string[]): LogsArgs {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const deploymentIdx = args.indexOf("--deployment");
  const limitIdx = args.indexOf("--limit");
  const severityIdx = args.indexOf("--severity");
  const grepIdx = args.indexOf("--grep");
  const jsonFlag = args.includes("--json");

  if (deploymentIdx === -1) {
    printUsageError("--deployment <id> is required");
  }

  const deploymentId = args[deploymentIdx + 1];
  if (!deploymentId || deploymentId.startsWith("--")) {
    printUsageError("--deployment requires an ID argument");
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

  let severity: string | undefined;
  if (severityIdx !== -1) {
    severity = args[severityIdx + 1];
    if (!severity || severity.startsWith("--")) {
      printUsageError("--severity requires a level argument");
    }
  }

  let grep: string | undefined;
  if (grepIdx !== -1) {
    grep = args[grepIdx + 1];
    if (!grep || grep.startsWith("--")) {
      printUsageError("--grep requires a pattern argument");
    }
  }

  return { deploymentId, limit, severity, grep, json: jsonFlag };
}

// --- Main ---

async function run(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let args: LogsArgs;
  try {
    args = parseArgs(process.argv);
  } catch (_err) {
    // parseArgs calls process.exit(1) on parse failure; this is a fallback
    process.exit(1);
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

  let logs: LogEntry[];
  try {
    logs = await fetchDeploymentLogs(args.deploymentId, args.limit, token);
  } catch (err) {
    if (err instanceof RailwayApiError) {
      console.error(`API error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const filtered = filterLogs(logs, args.severity, args.grep);

  if (args.json) {
    console.log(JSON.stringify(filtered, null, 2));
  } else {
    console.log(formatLogsOutput(filtered));
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
