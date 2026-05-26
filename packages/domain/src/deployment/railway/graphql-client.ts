/**
 * Railway GraphQL client primitives — shared between the v1
 * RailwayDeploymentAdapter and the existing scripts/railway/ bun scripts.
 *
 * Originally extracted from scripts/railway/status.ts and scripts/railway/logs.ts
 * as part of mt#1730; the bun scripts were intended to re-export these primitives
 * (via scripts/railway/lib.ts) but the consolidation was only partial. mt#2013
 * completes the consolidation AND adds OAuth refresh-token handling so the
 * access token (which Railway expires within ~5 hours) renews transparently
 * mid-process without requiring an operator-side `railway login`.
 *
 * Tracking tasks: mt#1730 (consolidation), mt#2013 (refresh + final consolidation).
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
export const RAILWAY_OAUTH_TOKEN_URL = "https://backboard.railway.com/oauth/token";

/**
 * Default OAuth client ID used by the Railway CLI when authenticating against
 * the public OAuth endpoint. Source: railwayapp/cli `src/oauth.rs`. Operators
 * may override via the `RAILWAY_OAUTH_CLIENT_ID` env var (same convention the
 * CLI uses).
 */
export const RAILWAY_OAUTH_DEFAULT_CLIENT_ID = "rlwy_oaci_onEklvmksh1hRUiCo7E2zX12";

const GRAPHQL_TIMEOUT_MS = 30_000;

/**
 * Refresh the access token when it's expired OR within this safety window
 * of expiring. Avoids the race where a token is checked as valid, then expires
 * before the GraphQL request lands.
 */
export const REFRESH_SAFETY_WINDOW_SECONDS = 300;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Config store abstraction
// ---------------------------------------------------------------------------
//
// `~/.railway/config.json` holds the credentials the Railway CLI maintains.
// We model read+write behind an injectable interface so tests can drive the
// refresh logic without touching the real filesystem.

export interface RailwayUserCredentials {
  accessToken?: string;
  refreshToken?: string;
  /** Unix epoch seconds when the access token expires. */
  tokenExpiresAt?: number;
  /** Separate field the Railway CLI stores; not modified by this module. */
  token?: string;
}

export interface RailwayConfigShape {
  user?: RailwayUserCredentials & Record<string, unknown>;
  [key: string]: unknown;
}

export interface RailwayConfigStore {
  read(): RailwayConfigShape;
  write(cfg: RailwayConfigShape): void;
}

function defaultRailwayConfigPath(): string {
  return join(homedir(), ".railway", "config.json");
}

/**
 * Default mode applied to a freshly-created `~/.railway/config.json`. The file
 * contains bearer + refresh tokens; private (owner-only) is the right baseline.
 * Mirrors Railway CLI's first-write convention.
 */
const DEFAULT_CONFIG_FILE_MODE = 0o600;

/**
 * Default fs-backed config store. Read and write the real
 * `~/.railway/config.json` file.
 *
 * Write semantics:
 * - **Atomic via temp + rename** to avoid partial writes on crash (PR #1228 R1
 *   NON-BLOCKING). A pid-suffixed temp file in the same directory is written
 *   first, then `rename`d over the target. `rename` within a single filesystem
 *   is atomic on POSIX; the reader will see either the old or new content,
 *   never a partial file.
 * - **Preserves existing file permissions** when the target file already
 *   exists; uses {@link DEFAULT_CONFIG_FILE_MODE} (`0o600`) when creating a
 *   new file. Prevents accidentally widening permissions on token-bearing
 *   data.
 * - **Best-effort last-write-wins.** Two concurrent processes refreshing
 *   simultaneously may stomp each other; the loser's stale access token will
 *   be rejected by Railway on its next use, triggering an idempotent
 *   re-refresh. A `proper-lockfile`-style file lock would be over-engineering
 *   for a single-CLI-per-machine consumer.
 */
export const defaultRailwayConfigStore: RailwayConfigStore = {
  read(): RailwayConfigShape {
    const cfgPath = defaultRailwayConfigPath();
    if (!existsSync(cfgPath)) {
      throw new RailwayAuthError(
        "Railway CLI is not authenticated (missing ~/.railway/config.json). Run: railway login"
      );
    }
    let parsed: RailwayConfigShape;
    try {
      parsed = JSON.parse(readFileSync(cfgPath, "utf-8").toString()) as RailwayConfigShape;
    } catch (err) {
      throw new RailwayAuthError(
        `Failed to parse ~/.railway/config.json: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    return parsed;
  },

  write(cfg: RailwayConfigShape): void {
    const cfgPath = defaultRailwayConfigPath();
    // Preserve the existing file's permission bits; fall back to 0o600 when
    // creating a new file (or stat fails).
    let mode = DEFAULT_CONFIG_FILE_MODE;
    try {
      const stats = statSync(cfgPath);
      mode = stats.mode & 0o777;
    } catch {
      // File doesn't exist (or stat failed); use the conservative default.
    }
    // Atomic write: write to a temp file in the same directory, then rename
    // over the target. Same-directory rename is atomic on POSIX.
    const tmpPath = `${cfgPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), { mode });
    renameSync(tmpPath, cfgPath);
  },
};

// ---------------------------------------------------------------------------
// Token reading (sync, deprecated) and refresh-aware async variant
// ---------------------------------------------------------------------------

/**
 * @deprecated Prefer {@link getValidRailwayToken} which transparently refreshes
 * the access token on expiry. This helper does a sync file read and returns
 * whatever access token is present; if it has expired, downstream GraphQL
 * calls will fail with "Not Authorized". Retained for back-compat with the
 * `(query, variables, token)` GraphQL-helper shape used across `scripts/` and
 * the v1 `RailwayDeploymentAdapter`; new code should use
 * {@link getValidRailwayToken} or {@link railwayGraphQLAuthed}.
 */
export function readRailwayToken(store: RailwayConfigStore = defaultRailwayConfigStore): string {
  const cfg = store.read();
  const token = cfg.user?.accessToken;
  if (!token) {
    throw new RailwayAuthError(
      "Railway CLI is not authenticated (no user.accessToken in ~/.railway/config.json). Run: railway login"
    );
  }
  return token;
}

/**
 * OAuth refresh-token response shape (RFC 6749 §5.1 plus Railway's rotated
 * refresh_token return). The Railway docs explicitly state that refresh_token
 * may rotate and the new value must be persisted.
 */
export interface TokenRefreshResponse {
  access_token: string;
  /** Present when Railway rotates the refresh token; absent means keep the old one. */
  refresh_token?: string;
  /** Seconds-relative expiry. Compute absolute as Math.floor(Date.now()/1000) + expires_in. */
  expires_in: number;
  token_type?: string;
}

/**
 * Low-level POST to `https://backboard.railway.com/oauth/token` with
 * `grant_type=refresh_token`. Exported for test seams; production callers
 * should use {@link getValidRailwayToken}.
 *
 * @throws RailwayAuthError on 4xx (refresh token expired/revoked).
 * @throws RailwayApiError on 5xx, network errors, timeouts, or parse failures.
 */
export async function refreshRailwayToken(
  refreshToken: string,
  opts?: { clientId?: string; fetchImpl?: typeof fetch }
): Promise<TokenRefreshResponse> {
  const clientId = opts?.clientId ?? resolveDefaultClientId();
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(RAILWAY_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RailwayApiError(`Railway token refresh timed out after ${GRAPHQL_TIMEOUT_MS}ms`);
    }
    throw new RailwayApiError(
      `Railway token refresh network error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await res.text();

  if (res.status >= 400 && res.status < 500) {
    // 4xx — auth failure (revoked refresh token, expired, rotated-but-superseded).
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- OAuth error body is ASCII JSON
    const truncated = text.length > 300 ? `${text.slice(0, 300)}...` : text;
    throw new RailwayAuthError(
      `Railway token refresh rejected (HTTP ${res.status} ${res.statusText}): ${truncated}. ` +
        `The refresh token may be expired or revoked. Run: railway login`
    );
  }

  if (!res.ok) {
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- OAuth error body is ASCII
    const truncated = text.length > 300 ? `${text.slice(0, 300)}...` : text;
    throw new RailwayApiError(
      `Railway token refresh failed (HTTP ${res.status} ${res.statusText}): ${truncated}`
    );
  }

  let parsed: TokenRefreshResponse;
  try {
    parsed = JSON.parse(text) as TokenRefreshResponse;
  } catch (err) {
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- OAuth response body is ASCII
    const truncated = text.length > 300 ? `${text.slice(0, 300)}...` : text;
    throw new RailwayApiError(`Railway token refresh returned non-JSON response: ${truncated}`, {
      cause: err,
    });
  }

  if (typeof parsed.access_token !== "string" || typeof parsed.expires_in !== "number") {
    throw new RailwayApiError(
      `Railway token refresh response missing expected fields (access_token, expires_in)`
    );
  }

  return parsed;
}

function resolveDefaultClientId(): string {
  return process.env["RAILWAY_OAUTH_CLIENT_ID"] ?? RAILWAY_OAUTH_DEFAULT_CLIENT_ID;
}

// ---------------------------------------------------------------------------
// Single-flight refresh + persist
// ---------------------------------------------------------------------------
//
// When the access token is past/near expiry and a refresh is needed, the
// first caller initiates the POST; concurrent callers await the same promise.
// Cleared on resolve/reject so the next round-trip can start fresh.
//
// Per-process module state; acceptable because scripts run as one-shot CLIs
// and the production adapter runs in a single Node process per request.
let inflightRefresh: Promise<string> | null = null;

export interface GetValidRailwayTokenOptions {
  store?: RailwayConfigStore;
  fetchImpl?: typeof fetch;
  clientId?: string;
  /** Override for tests; defaults to current Unix epoch seconds. */
  nowSeconds?: () => number;
}

/**
 * Return a Railway access token guaranteed to be valid at call time
 * (within the {@link REFRESH_SAFETY_WINDOW_SECONDS} window).
 *
 * Reads `~/.railway/config.json`; if `tokenExpiresAt` is past or within the
 * safety window AND `refreshToken` is present, POSTs to the OAuth refresh
 * endpoint to obtain a new access token, persists the updated credentials,
 * and returns the new token. Concurrent calls during the refresh window
 * share a single in-flight refresh (no duplicate POSTs).
 *
 * @throws RailwayAuthError when no access token is present, when the access
 *   token is expired and no refresh token is available, or when refresh is
 *   rejected by Railway.
 * @throws RailwayApiError on network errors / timeouts / 5xx.
 */
export async function getValidRailwayToken(opts?: GetValidRailwayTokenOptions): Promise<string> {
  const store = opts?.store ?? defaultRailwayConfigStore;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const clientId = opts?.clientId ?? resolveDefaultClientId();
  const nowSeconds = opts?.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  const cfg = store.read();
  const user = cfg.user ?? {};
  const accessToken = user.accessToken;
  const refreshToken = user.refreshToken;
  const expiresAt = user.tokenExpiresAt;

  if (!accessToken) {
    throw new RailwayAuthError(
      "Railway CLI is not authenticated (no user.accessToken in ~/.railway/config.json). Run: railway login"
    );
  }

  const now = nowSeconds();
  const needsRefresh =
    typeof expiresAt === "number" && expiresAt - now < REFRESH_SAFETY_WINDOW_SECONDS;

  if (!needsRefresh) {
    return accessToken;
  }

  if (!refreshToken) {
    throw new RailwayAuthError(
      "Railway access token has expired (or is expiring) and no refresh token is available in ~/.railway/config.json. Run: railway login"
    );
  }

  if (inflightRefresh) {
    return inflightRefresh;
  }

  const refreshPromise = performRefresh(refreshToken, clientId, fetchImpl, store, nowSeconds);
  inflightRefresh = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    // Clear only if still pointing to this promise — protects against a
    // theoretical re-entry where another caller raced to set inflightRefresh.
    if (inflightRefresh === refreshPromise) {
      inflightRefresh = null;
    }
  }
}

async function performRefresh(
  refreshToken: string,
  clientId: string,
  fetchImpl: typeof fetch,
  store: RailwayConfigStore,
  nowSeconds: () => number
): Promise<string> {
  const response = await refreshRailwayToken(refreshToken, { clientId, fetchImpl });

  // Persist updated credentials, preserving every other field.
  const cfg = store.read();
  const updatedCfg: RailwayConfigShape = {
    ...cfg,
    user: {
      ...(cfg.user ?? {}),
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? refreshToken,
      tokenExpiresAt: nowSeconds() + response.expires_in,
    },
  };
  store.write(updatedCfg);

  return response.access_token;
}

/** Test-only: reset the single-flight refresh state between cases. */
export function _resetInflightRefreshForTesting(): void {
  inflightRefresh = null;
}

// ---------------------------------------------------------------------------
// GraphQL transport
// ---------------------------------------------------------------------------

/**
 * Execute a Railway GraphQL query. Throws RailwayApiError on HTTP errors,
 * parse failures, or GraphQL error responses.
 *
 * Token is passed as an explicit argument; callers that want refresh-aware
 * auth should obtain the token via {@link getValidRailwayToken} or use the
 * convenience helper {@link railwayGraphQLAuthed}.
 */
export async function railwayGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(RAILWAY_GRAPHQL_URL, {
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

/**
 * Refresh-aware convenience wrapper around {@link railwayGraphQL}. Obtains
 * a valid access token (refreshing if needed) and forwards to the
 * stateless transport. This is the preferred entry point for new callers.
 */
export async function railwayGraphQLAuthed<T>(
  query: string,
  variables: Record<string, unknown>,
  opts?: GetValidRailwayTokenOptions
): Promise<T> {
  const token = await getValidRailwayToken(opts);
  return railwayGraphQL<T>(query, variables, token, opts?.fetchImpl);
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
  attributes?: Array<{ key: string; value: string }>;
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
      attributes { key value }
    }
  }
`;

const BUILD_LOGS_QUERY = `
  query ($deploymentId: String!, $limit: Int!) {
    buildLogs(deploymentId: $deploymentId, limit: $limit) {
      message
      timestamp
      severity
      attributes { key value }
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
