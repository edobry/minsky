#!/usr/bin/env bun
/**
 * Post-deploy outcome + health monitor (mt#1302).
 *
 * Checks every deployed Railway service for:
 *   (a) Latest deploy terminal status — alerts on FAILED / CRASHED.
 *       Catches the mt#1991 build-failure class.
 *   (b) GET <service>/health returns 200 — alerts on non-200 / timeout.
 *       Catches the mt#2345 runtime-crash-after-green-build class.
 *
 * Primary alert:   Open / update a GitHub P0 issue per service+failure-class.
 *                  De-duped so a sustained outage updates ONE issue, not N.
 * Secondary alert: POST an asks_create coordination.notify over hosted MCP
 *                  (best-effort; wrapped in try/catch so its failure NEVER
 *                  suppresses the primary path).
 *
 * USAGE (in GitHub Actions):
 *   RAILWAY_TOKEN=... GITHUB_TOKEN=... GITHUB_REPO=edobry/minsky bun scripts/post-deploy-health-monitor.ts
 *
 * USAGE (local dry-run — no RAILWAY_TOKEN needed, skips Railway checks):
 *   DRY_RUN=true GITHUB_TOKEN=... GITHUB_REPO=edobry/minsky bun scripts/post-deploy-health-monitor.ts
 *
 * ENV VARS:
 *   RAILWAY_TOKEN          — Railway API token (read access). Skip Railway
 *                            checks when absent (graceful degradation).
 *   GITHUB_TOKEN           — GitHub PAT or Actions token with issues:write.
 *   GITHUB_REPO            — "owner/repo" (e.g. "edobry/minsky").
 *   MINSKY_MCP_AUTH_TOKEN  — Bearer token for hosted MCP (secondary path).
 *                            When absent, secondary path is skipped.
 *   DRY_RUN                — "true" to log only; no GitHub issues or MCP calls.
 *
 * SECRETS:
 *   RAILWAY_TOKEN, MINSKY_MCP_AUTH_TOKEN, GITHUB_TOKEN are consumed from env.
 *   None are logged or embedded in outputs.
 *
 * Architecture: external to all monitored services; runs on GitHub Actions.
 * See .github/workflows/post-deploy-health-monitor.yml for the host.
 */

// ---------------------------------------------------------------------------
// Service definitions
// ---------------------------------------------------------------------------

interface ServiceDef {
  /** Human-readable name used in issue titles and log output. */
  name: string;
  /** Railway serviceId. Empty string = not provisioned yet — skip gracefully. */
  serviceId: string;
  /** HTTP URL for the health endpoint. Null = no HTTP health check. */
  healthUrl: string | null;
}

const SERVICES: ServiceDef[] = [
  {
    name: "minsky-mcp",
    serviceId: "a7c5195f-55de-472a-87e4-34e921a15171",
    healthUrl: "https://minsky-mcp-production.up.railway.app/health",
  },
  {
    name: "reviewer",
    serviceId: "3913e8a4-81ab-465a-aad8-b76b5e3f66ed",
    healthUrl: "https://minsky-reviewer-webhook-production.up.railway.app/health",
  },
  {
    name: "cockpit",
    serviceId: "83273eef-b451-42af-b3e4-7e1c42b8bb50",
    // Cockpit exposes /api/health (not /health) — verified via cockpit-preview.yml
    healthUrl: "https://cockpit-preview-production.up.railway.app/api/health",
  },
  {
    name: "site",
    serviceId: "bb4d7cb4-e929-4ab6-83e2-d19cd34f6805",
    healthUrl: "https://minsky-site-production.up.railway.app/health",
  },
  // minsky-ops: serviceId is empty (not yet provisioned) — skipped gracefully.
  {
    name: "minsky-ops",
    serviceId: "",
    healthUrl: null,
  },
];

// ---------------------------------------------------------------------------
// Railway API
// ---------------------------------------------------------------------------

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const HEALTH_TIMEOUT_MS = 10_000;
const RAILWAY_TIMEOUT_MS = 15_000;

/** Terminal statuses that mean "this deploy is done and it failed." */
const FAILED_TERMINAL_STATUSES = new Set(["FAILED", "CRASHED"]);

interface RailwayDeploymentNode {
  id: string;
  status: string;
  createdAt: string;
  staticUrl?: string | null;
  meta?: { commitHash?: string; commitMessage?: string } | null;
}

interface RailwayDeploymentsResponse {
  service: {
    deployments: {
      edges: { node: RailwayDeploymentNode }[];
    };
  };
}

const LATEST_DEPLOYMENT_QUERY = `
  query ($serviceId: String!) {
    service(id: $serviceId) {
      deployments(first: 1) {
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

async function fetchLatestDeployment(
  serviceId: string,
  token: string
): Promise<RailwayDeploymentNode | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RAILWAY_TIMEOUT_MS);

  try {
    const res = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: LATEST_DEPLOYMENT_QUERY, variables: { serviceId } }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Railway API HTTP ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as {
      data?: RailwayDeploymentsResponse;
      errors?: { message?: string }[];
    };

    if (body.errors?.length) {
      throw new Error(`Railway GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }

    const edges = body.data?.service?.deployments?.edges ?? [];
    return edges[0]?.node ?? null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

interface HealthProbeResult {
  ok: boolean;
  statusCode: number | null;
  /** Short snippet of response body for the alert body (redacted if sensitive). */
  bodySnippet: string;
  error: string | null;
}

async function probeHealth(url: string): Promise<HealthProbeResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const bodyText = await res.text().catch(() => "");
    // Limit snippet to 200 chars to keep issue bodies readable.
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- HTTP health response bodies are ASCII (JSON, plain text status)
    const bodySnippet = bodyText.slice(0, 200);
    return {
      ok: res.status === 200,
      statusCode: res.status,
      bodySnippet,
      error: null,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      statusCode: null,
      bodySnippet: "",
      error: isTimeout ? `Timeout after ${HEALTH_TIMEOUT_MS}ms` : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// GitHub Issues — primary alert
// ---------------------------------------------------------------------------

/** Label applied to all P0 issues created by this monitor. */
const P0_LABEL = "p0-outage";
/** Label used to search for open monitor issues. */
const MONITOR_LABEL = "post-deploy-monitor";

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  body: string | null;
}

async function githubRequest<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
  }

  // Some endpoints return 204 No Content.
  if (res.status === 204) return undefined as T;
  return res.json() as T;
}

/**
 * Issue title for a given service+failure-class combo.
 * Used as the de-duplication key: search for an open issue with this exact title.
 */
function issueTitle(serviceName: string, failureClass: "deploy-failed" | "health-down"): string {
  const classLabel =
    failureClass === "deploy-failed" ? "Deploy FAILED/CRASHED" : "Health check DOWN";
  return `[P0] ${serviceName}: ${classLabel}`;
}

/**
 * Find an existing open issue by title in the repo.
 * Returns null when none found.
 */
async function findOpenIssue(
  repo: string,
  title: string,
  token: string
): Promise<GitHubIssue | null> {
  // Search for open issues with the monitor label and matching title.
  const encoded = encodeURIComponent(
    `repo:${repo} is:open is:issue label:${MONITOR_LABEL} in:title "${title}"`
  );
  const results = await githubRequest<{ items: GitHubIssue[] }>(
    "GET",
    `/search/issues?q=${encoded}&per_page=5`,
    token
  );
  // Exact-match the title in case search is fuzzy.
  return results.items.find((i) => i.title === title) ?? null;
}

async function ensureLabelsExist(repo: string, token: string): Promise<void> {
  for (const label of [P0_LABEL, MONITOR_LABEL]) {
    try {
      await githubRequest("GET", `/repos/${repo}/labels/${encodeURIComponent(label)}`, token);
    } catch {
      // Label doesn't exist — create it.
      try {
        await githubRequest("POST", `/repos/${repo}/labels`, token, {
          name: label,
          color: label === P0_LABEL ? "B60205" : "0075CA",
          description:
            label === P0_LABEL
              ? "P0 outage: service is down or deploy failed"
              : "Auto-opened by post-deploy-health-monitor (mt#1302)",
        });
      } catch (err) {
        // Non-fatal: issue can still be opened without labels.
        console.warn(`[github] could not create label "${label}": ${err}`);
      }
    }
  }
}

/**
 * Open or update a GitHub issue for a service failure.
 * De-duplication: if an open issue with the same title already exists, append
 * a comment (or update the body timestamp) rather than opening a duplicate.
 *
 * Returns the issue URL.
 */
async function alertViaGitHubIssue(
  repo: string,
  token: string,
  serviceName: string,
  failureClass: "deploy-failed" | "health-down",
  details: string,
  dryRun: boolean
): Promise<string> {
  const title = issueTitle(serviceName, failureClass);
  const timestamp = new Date().toISOString();

  const body = [
    `## P0: ${title}`,
    "",
    `**Detected at:** ${timestamp}`,
    `**Service:** \`${serviceName}\``,
    `**Failure class:** \`${failureClass}\``,
    "",
    "### Details",
    "",
    details,
    "",
    "---",
    "*Auto-opened by [post-deploy-health-monitor](.github/workflows/post-deploy-health-monitor.yml) (mt#1302).*",
    "*Close this issue when the service is confirmed healthy.*",
  ].join("\n");

  if (dryRun) {
    console.log(`[dry-run] Would open/update GitHub issue: "${title}"`);
    console.log(`[dry-run] Body:\n${body}`);
    return "(dry-run — no issue URL)";
  }

  // Ensure labels exist before trying to use them (idempotent).
  await ensureLabelsExist(repo, token);

  const existing = await findOpenIssue(repo, title, token);
  if (existing) {
    // Issue already open — add a comment noting the recurrence.
    const comment = `**Still failing** as of ${timestamp}\n\n${details}`;
    await githubRequest("POST", `/repos/${repo}/issues/${existing.number}/comments`, token, {
      body: comment,
    });
    const issueUrl = `https://github.com/${repo}/issues/${existing.number}`;
    console.log(`[github] Updated existing issue #${existing.number}: ${issueUrl}`);
    return issueUrl;
  }

  // Open a new issue.
  const newIssue = await githubRequest<GitHubIssue>("POST", `/repos/${repo}/issues`, token, {
    title,
    body,
    labels: [P0_LABEL, MONITOR_LABEL],
  });
  const issueUrl = `https://github.com/${repo}/issues/${newIssue.number}`;
  console.log(`[github] Opened new issue #${newIssue.number}: ${issueUrl}`);
  return issueUrl;
}

// ---------------------------------------------------------------------------
// Secondary alert: MCP asks_create (best-effort)
// ---------------------------------------------------------------------------

const MINSKY_MCP_URL = "https://minsky-mcp-production.up.railway.app/mcp";
const MCP_TIMEOUT_MS = 15_000;

async function alertViaMcp(mcpAuthToken: string, subject: string, details: string): Promise<void> {
  // Minimal JSON-RPC asks_create call over HTTP MCP.
  // This path is fire-and-forget; any error is caught by the caller.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

  try {
    // Initialize MCP session first.
    const initRes = await fetch(MINSKY_MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpAuthToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "post-deploy-health-monitor", version: "1.0" },
        },
      }),
      signal: controller.signal,
    });

    if (!initRes.ok) {
      throw new Error(`MCP init HTTP ${initRes.status}`);
    }

    // Extract session ID from response headers (minsky-mcp uses Mcp-Session-Id).
    const sessionId = initRes.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new Error("MCP init response missing mcp-session-id header");
    }

    // Call asks_create with a coordination.notify ask.
    const callRes = await fetch(MINSKY_MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpAuthToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "mcp__minsky__asks_create",
          arguments: {
            kind: "coordination.notify",
            subject,
            body: details,
            priority: "p0",
          },
        },
      }),
      signal: controller.signal,
    });

    if (!callRes.ok) {
      throw new Error(`MCP asks_create HTTP ${callRes.status}`);
    }

    console.log("[mcp] asks_create coordination.notify sent successfully");
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Per-service check
// ---------------------------------------------------------------------------

interface CheckResult {
  service: string;
  deployStatus: string | null;
  deployId: string | null;
  deployCreatedAt: string | null;
  deployAlert: boolean;
  healthStatus: number | null;
  healthOk: boolean;
  healthAlert: boolean;
  healthError: string | null;
  skipped: boolean;
  skipReason: string | null;
}

async function checkService(svc: ServiceDef, railwayToken: string | null): Promise<CheckResult> {
  // Skip services without a provisioned Railway serviceId.
  if (!svc.serviceId) {
    return {
      service: svc.name,
      deployStatus: null,
      deployId: null,
      deployCreatedAt: null,
      deployAlert: false,
      healthStatus: null,
      healthOk: true,
      healthAlert: false,
      healthError: null,
      skipped: true,
      skipReason: "serviceId not provisioned",
    };
  }

  // --- (a) Railway deploy status ---
  let deployStatus: string | null = null;
  let deployId: string | null = null;
  let deployCreatedAt: string | null = null;
  let deployAlert = false;

  if (railwayToken) {
    try {
      const deployment = await fetchLatestDeployment(svc.serviceId, railwayToken);
      if (deployment) {
        deployStatus = deployment.status;
        deployId = deployment.id;
        deployCreatedAt = deployment.createdAt;
        deployAlert = FAILED_TERMINAL_STATUSES.has(deployment.status);
      } else {
        deployStatus = "NO_DEPLOYMENTS";
      }
    } catch (err) {
      console.warn(`[${svc.name}] Railway deploy check failed: ${err}`);
      // Non-fatal: continue to health check.
      deployStatus = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    deployStatus = "SKIPPED (no RAILWAY_TOKEN)";
  }

  // --- (b) HTTP /health probe ---
  let healthOk = true;
  let healthStatus: number | null = null;
  let healthAlert = false;
  let healthError: string | null = null;

  if (svc.healthUrl) {
    const probe = await probeHealth(svc.healthUrl);
    healthOk = probe.ok;
    healthStatus = probe.statusCode;
    healthError = probe.error;
    healthAlert = !probe.ok;
  }

  return {
    service: svc.name,
    deployStatus,
    deployId,
    deployCreatedAt,
    deployAlert,
    healthStatus,
    healthOk,
    healthAlert,
    healthError,
    skipped: false,
    skipReason: null,
  };
}

// ---------------------------------------------------------------------------
// Format alert details
// ---------------------------------------------------------------------------

function formatDeployFailedDetails(svc: ServiceDef, result: CheckResult): string {
  return [
    `- **Service:** \`${svc.name}\``,
    `- **Deploy status:** \`${result.deployStatus ?? "unknown"}\``,
    `- **Deploy ID:** \`${result.deployId ?? "unknown"}\``,
    `- **Deploy created at:** ${result.deployCreatedAt ?? "unknown"}`,
    "",
    "**Action:** Check Railway dashboard for build/deploy logs.",
    "",
    `**Railway service ID:** \`${svc.serviceId}\``,
  ].join("\n");
}

function formatHealthDownDetails(svc: ServiceDef, result: CheckResult): string {
  return [
    `- **Service:** \`${svc.name}\``,
    `- **Health URL:** \`${svc.healthUrl}\``,
    `- **HTTP status:** ${result.healthStatus ?? "no response"}`,
    result.healthError ? `- **Error:** ${result.healthError}` : null,
    `- **Deploy status:** \`${result.deployStatus ?? "unknown"}\` (for context)`,
    "",
    "**Action:** Check Railway dashboard and service logs.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const railwayToken = process.env["RAILWAY_TOKEN"] ?? null;
  const githubToken = process.env["GITHUB_TOKEN"] ?? null;
  const githubRepo = process.env["GITHUB_REPO"] ?? null;
  const mcpAuthToken = process.env["MINSKY_MCP_AUTH_TOKEN"] ?? null;
  const dryRun = (process.env["DRY_RUN"] ?? "false").toLowerCase() === "true";

  if (!githubToken || !githubRepo) {
    console.error("FATAL: GITHUB_TOKEN and GITHUB_REPO are required.");
    process.exit(1);
  }

  if (!railwayToken) {
    console.warn(
      "WARNING: RAILWAY_TOKEN not set — Railway deploy-status checks will be skipped. " +
        "Only /health probes will run."
    );
  }

  console.log(`=== post-deploy-health-monitor (mt#1302) ===`);
  console.log(`Repo: ${githubRepo}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Railway token: ${railwayToken ? "present" : "absent"}`);
  console.log(`MCP auth token: ${mcpAuthToken ? "present" : "absent"}`);
  console.log(`Checking ${SERVICES.length} services...\n`);

  let totalAlerts = 0;

  for (const svc of SERVICES) {
    console.log(`--- [${svc.name}] ---`);

    let result: CheckResult;
    try {
      result = await checkService(svc, railwayToken);
    } catch (err) {
      console.error(`[${svc.name}] Unexpected error during check: ${err}`);
      // Trust-boundary: one service error must not crash the sweep.
      continue;
    }

    if (result.skipped) {
      console.log(`  SKIPPED: ${result.skipReason}`);
      continue;
    }

    // Log current state.
    console.log(`  Deploy status: ${result.deployStatus ?? "n/a"}`);
    if (result.deployId) console.log(`  Deploy ID:     ${result.deployId}`);
    if (svc.healthUrl) {
      console.log(
        `  Health:        HTTP ${result.healthStatus ?? "timeout"} — ${result.healthOk ? "OK" : "FAIL"}`
      );
    }

    const alerts: Array<{ class: "deploy-failed" | "health-down"; details: string }> = [];

    if (result.deployAlert) {
      alerts.push({
        class: "deploy-failed",
        details: formatDeployFailedDetails(svc, result),
      });
    }

    if (result.healthAlert) {
      alerts.push({
        class: "health-down",
        details: formatHealthDownDetails(svc, result),
      });
    }

    if (alerts.length === 0) {
      console.log(`  Status: HEALTHY`);
      continue;
    }

    totalAlerts += alerts.length;

    for (const alert of alerts) {
      console.log(`  ALERT [${alert.class}]: opening/updating GitHub issue...`);

      // PRIMARY: GitHub issue (infra-independent, always attempted).
      let issueUrl = "(unknown)";
      try {
        issueUrl = await alertViaGitHubIssue(
          githubRepo,
          githubToken,
          svc.name,
          alert.class,
          alert.details,
          dryRun
        );
      } catch (err) {
        // Log but continue — one issue-write failure must not block others.
        console.error(`  [github] ERROR opening issue: ${err}`);
      }

      // SECONDARY: MCP asks_create (best-effort).
      // Only attempt when MCP auth token is available.
      if (mcpAuthToken && !dryRun) {
        try {
          const subject = `[P0] ${svc.name}: ${alert.class} — GitHub issue ${issueUrl}`;
          await alertViaMcp(mcpAuthToken, subject, alert.details);
        } catch (err) {
          // Best-effort: log but NEVER suppress the primary path.
          console.warn(`  [mcp] secondary alert failed (non-fatal): ${err}`);
        }
      } else if (mcpAuthToken && dryRun) {
        console.log(`  [dry-run] Would send MCP asks_create for ${svc.name}/${alert.class}`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total alerts fired: ${totalAlerts}`);

  // Exit non-zero when any alerts fired so the Actions step is visually
  // distinct in the run log (yellow warning vs. green checkmark).
  if (totalAlerts > 0) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("Monitor script unexpectedly crashed:", err);
  process.exit(1);
});
