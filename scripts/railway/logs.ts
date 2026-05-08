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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const GRAPHQL_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 100;

// --- Auth ---

export class AuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiError";
  }
}

/** Reads the Railway bearer token from ~/.railway/config.json */
export function readRailwayToken(): string {
  const cfgPath = join(homedir(), ".railway", "config.json");
  if (!existsSync(cfgPath)) {
    throw new AuthError(
      "Railway CLI is not authenticated (missing ~/.railway/config.json). Run: railway login"
    );
  }
  let cfg: { user?: { accessToken?: string } };
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as typeof cfg;
  } catch (err) {
    throw new AuthError(
      `Failed to parse ~/.railway/config.json: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  const token = cfg.user?.accessToken;
  if (!token) {
    throw new AuthError(
      "Railway CLI is not authenticated (no user.accessToken in ~/.railway/config.json). Run: railway login"
    );
  }
  return token;
}

// --- GraphQL client ---

export async function graphql<T>(
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
      throw new ApiError(`Railway API request timed out after ${GRAPHQL_TIMEOUT_MS}ms`);
    }
    throw new ApiError(
      `Railway API network error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const bodyText = await res.text();

  if (!res.ok) {
    const truncated = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
    throw new ApiError(
      `Railway API request failed: HTTP ${res.status} ${res.statusText}. ` +
        `Body: ${truncated}. ` +
        `Check your Railway token and network connectivity.`
    );
  }

  let body: { data?: T; errors?: { message?: string; path?: (string | number)[] }[] };
  try {
    body = JSON.parse(bodyText) as typeof body;
  } catch (parseErr) {
    const truncated = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
    throw new ApiError(
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
    throw new ApiError(`GraphQL error: ${summary}`);
  }
  if (!body.data) {
    throw new ApiError(`GraphQL returned no data for query: ${query.slice(0, 80)}`);
  }
  return body.data;
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
    token = readRailwayToken();
  } catch (err) {
    if (err instanceof AuthError) {
      console.error(`Auth error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  let logs: LogEntry[];
  try {
    logs = await fetchDeploymentLogs(args.deploymentId, args.limit, token);
  } catch (err) {
    if (err instanceof ApiError) {
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
