#!/usr/bin/env bun
/**
 * Smoke test / verification artifact for the post-deploy health monitor (mt#1302).
 *
 * Exercises the monitor's check logic against the live Railway services,
 * verifying each probe path works end-to-end.
 *
 * This script is the §7a "structural change verification artifact" for mt#1302.
 * It is:
 *   - Runnable from the command line with: bun scripts/smoke-post-deploy-health-monitor.ts
 *   - Env-gated: skips gracefully when required secrets are absent
 *   - Exit-coded: 0 = pass, 1 = fail, 2 = skipped (missing env)
 *
 * SERVICE DISCOVERY (mt#1302 R1 fix):
 *   Health targets are discovered at runtime from services/<svc>/deploy.config.ts
 *   (glob: services/[star]/deploy.config.ts), matching the production monitor.
 *   No health URLs are hardcoded here.
 *
 * USAGE:
 *   # Full run (with Railway token):
 *   RAILWAY_TOKEN=... bun scripts/smoke-post-deploy-health-monitor.ts
 *
 *   # Health-only run (no Railway token — skips deploy-status checks):
 *   bun scripts/smoke-post-deploy-health-monitor.ts
 *
 * ENV VARS:
 *   RAILWAY_TOKEN     — Railway API token. When absent, deploy-status checks
 *                       are skipped (health probes still run).
 *   SMOKE_VERBOSE     — "true" to show full response bodies.
 *
 * WHAT IS CHECKED:
 *   Phase 1: /health probe reachability — each service with a healthUrl (from
 *            deploy.config.ts) must respond (any HTTP status). We assert we
 *            got a connection, not a 200, because the service may be
 *            legitimately down during smoke-test.
 *   Phase 2: Railway API reachability — if RAILWAY_TOKEN is set, verify that
 *            the GraphQL endpoint returns at least one deployment for a known
 *            service (minsky-mcp, from deploy.config.ts) without a transport error.
 *   Phase 3: GitHub issue de-dup logic (unit-level, no network) — verify that
 *            issueTitle() returns stable, unique strings per service+class combo.
 */

import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HEALTH_TIMEOUT_MS = 10_000;
const RAILWAY_TIMEOUT_MS = 15_000;
const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

const verbose = (process.env["SMOKE_VERBOSE"] ?? "false").toLowerCase() === "true";
const railwayToken = process.env["RAILWAY_TOKEN"] ?? null;

interface SmokeResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

const results: SmokeResult[] = [];

function pass(name: string, detail: string): void {
  results.push({ name, status: "pass", detail });
  console.log(`  PASS  ${name}: ${detail}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, status: "fail", detail });
  console.error(`  FAIL  ${name}: ${detail}`);
}

function skip(name: string, detail: string): void {
  results.push({ name, status: "skip", detail });
  console.log(`  SKIP  ${name}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Service discovery (mirrors production monitor)
// ---------------------------------------------------------------------------

interface DiscoveredService {
  name: string;
  serviceId: string;
  healthUrl: string | null;
  /**
   * mt#3251 — configured GHCR image ref for image-source deploys, read from
   * `railway.source.image`. Null for repo-source deploys.
   */
  image: string | null;
}

/**
 * Discover services from services/<svc>/deploy.config.ts files
 * (glob: services/[star]/deploy.config.ts), matching the production monitor's
 * discovery logic. Health targets and serviceIds are read from the config
 * files — not hardcoded here. This ensures the smoke test probes the same
 * service list as the production monitor.
 */
async function discoverServices(repoRoot: string): Promise<DiscoveredService[]> {
  const servicesDir = join(repoRoot, "services");

  let serviceNames: string[];
  try {
    serviceNames = readdirSync(servicesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    throw new Error(`Failed to enumerate services directory at ${servicesDir}: ${err}`);
  }

  const discovered: DiscoveredService[] = [];

  for (const name of serviceNames) {
    const configPath = join(servicesDir, name, "deploy.config.ts");

    let mod: { default?: unknown };
    try {
      mod = (await import(configPath)) as { default?: unknown };
    } catch {
      continue;
    }

    const cfg = mod.default;
    if (!cfg || typeof cfg !== "object" || !("platform" in cfg) || !("railway" in cfg)) {
      continue;
    }

    const railway = (cfg as { railway: Record<string, unknown> }).railway;
    const serviceId = typeof railway["serviceId"] === "string" ? railway["serviceId"] : "";
    const healthUrl =
      "healthUrl" in cfg ? ((cfg as { healthUrl?: string | null }).healthUrl ?? null) : null;
    const source = railway["source"];
    const image =
      source &&
      typeof source === "object" &&
      typeof (source as Record<string, unknown>)["image"] === "string"
        ? ((source as Record<string, unknown>)["image"] as string)
        : null;

    discovered.push({ name, serviceId, healthUrl, image });
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// Phase 1: /health probe reachability
// ---------------------------------------------------------------------------

async function runHealthPhase(services: DiscoveredService[]): Promise<void> {
  console.log("\nPhase 1: /health probe reachability");
  console.log("-".repeat(50));

  const healthTargets = services.filter(
    (s): s is DiscoveredService & { healthUrl: string } =>
      s.healthUrl !== null && s.serviceId !== ""
  );

  if (healthTargets.length === 0) {
    skip("health-reachable", "No services with healthUrl found in deploy.config.ts files");
    return;
  }

  for (const target of healthTargets) {
    const url = target.healthUrl;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });
      const bodyText = await res.text().catch(() => "");
      if (verbose) {
        // eslint-disable-next-line custom/no-unsafe-string-truncation -- HTTP health response bodies are ASCII (JSON, plain text status)
        console.log(`    [${target.name}] HTTP ${res.status} — ${bodyText.slice(0, 100)}`);
      }
      // We assert reachability (got a response), not a 200, because the
      // service could legitimately be down during the smoke test run.
      pass(
        `health-reachable:${target.name}`,
        `HTTP ${res.status} (service is ${res.status === 200 ? "healthy" : "reachable but not 200"})`
      );
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const reason = isTimeout ? `timed out after ${HEALTH_TIMEOUT_MS}ms` : String(err);
      // A timeout or connection refused counts as a real probe failure.
      // This is what the monitor would alert on in production.
      fail(`health-reachable:${target.name}`, reason);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Railway API reachability
// ---------------------------------------------------------------------------

async function runRailwayPhase(services: DiscoveredService[]): Promise<void> {
  console.log("\nPhase 2: Railway API reachability");
  console.log("-".repeat(50));

  if (!railwayToken) {
    skip(
      "railway-api",
      "RAILWAY_TOKEN not set — skipping Railway deploy-status checks. " +
        "Set RAILWAY_TOKEN to test this path."
    );
    return;
  }

  // Use minsky-mcp's serviceId as the test subject — read from deploy.config.ts.
  const minskyMcp = services.find((s) => s.name === "minsky-mcp");
  if (!minskyMcp || !minskyMcp.serviceId) {
    skip("railway-api", "minsky-mcp service not found or has no serviceId in deploy.config.ts");
    return;
  }

  const testServiceId = minskyMcp.serviceId;
  const query = `
    query ($serviceId: String!) {
      service(id: $serviceId) {
        deployments(first: 1) {
          edges {
            node {
              id
              status
              createdAt
            }
          }
        }
      }
    }
  `;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RAILWAY_TIMEOUT_MS);

  try {
    const res = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${railwayToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { serviceId: testServiceId } }),
      signal: controller.signal,
    });

    if (!res.ok) {
      fail("railway-api", `HTTP ${res.status}: ${await res.text()}`);
      return;
    }

    const body = (await res.json()) as {
      data?: {
        service?: {
          deployments?: {
            edges?: { node: { id: string; status: string; createdAt: string } }[];
          };
        };
      };
      errors?: { message?: string }[];
    };

    if (body.errors?.length) {
      fail("railway-api", `GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
      return;
    }

    const edges = body.data?.service?.deployments?.edges ?? [];
    if (edges.length === 0) {
      fail("railway-api", "No deployments returned for minsky-mcp — unexpected for a live service");
      return;
    }

    const latest = edges[0]?.node;
    if (verbose) {
      console.log(
        `    Latest minsky-mcp deploy: ${latest?.id} / ${latest?.status} @ ${latest?.createdAt}`
      );
    }

    pass(
      "railway-api",
      `GraphQL responded; latest minsky-mcp deploy status: ${latest?.status ?? "unknown"}`
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    fail("railway-api", isTimeout ? `timed out after ${RAILWAY_TIMEOUT_MS}ms` : String(err));
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Phase 3: issue-title de-dup logic (unit-level, no network)
// ---------------------------------------------------------------------------

function issueTitle(
  serviceName: string,
  failureClass: "deploy-failed" | "health-down" | "digest-lag"
): string {
  const classLabel =
    failureClass === "deploy-failed"
      ? "Deploy FAILED/CRASHED"
      : failureClass === "health-down"
        ? "Health check DOWN"
        : "Deployed image digest lags registry";
  return `[P0] ${serviceName}: ${classLabel}`;
}

function runDeduplicationPhase(services: DiscoveredService[]): void {
  console.log("\nPhase 3: issue-title de-duplication logic");
  console.log("-".repeat(50));

  // Use discovered service names (excluding skipped ones with empty serviceId).
  const activeServices = services.filter((s) => s.serviceId !== "").map((s) => s.name);
  const classes = ["deploy-failed", "health-down", "digest-lag"] as const;

  const titles = new Set<string>();
  let allUnique = true;

  for (const svc of activeServices) {
    for (const cls of classes) {
      const title = issueTitle(svc, cls);
      if (titles.has(title)) {
        fail(`dedup:${svc}:${cls}`, `Duplicate title: "${title}"`);
        allUnique = false;
      } else {
        titles.add(title);
      }
    }
  }

  if (allUnique) {
    pass("dedup-uniqueness", `All ${titles.size} title combinations are unique`);
  }

  // Verify stable format using a known service name.
  const expected = "[P0] minsky-mcp: Deploy FAILED/CRASHED";
  const actual = issueTitle("minsky-mcp", "deploy-failed");
  if (actual === expected) {
    pass("dedup-format", `Title format is stable: "${actual}"`);
  } else {
    fail("dedup-format", `Title format changed. Expected "${expected}", got "${actual}"`);
  }
}

// ---------------------------------------------------------------------------
// Phase 4: GHCR digest-lag mechanism (mt#3251)
// ---------------------------------------------------------------------------
//
// Exercises the exact mechanism check (c) in the production monitor depends
// on: the anonymous GHCR registry-token flow for each image-source service's
// configured tag. Reachability (can we fetch a digest at all) is asserted
// unconditionally — no RAILWAY_TOKEN required, since GHCR needs no secret.
// When RAILWAY_TOKEN IS set, additionally fetches the deployed digest from
// Railway and reports whether it matches the registry (informational —
// a real lag at smoke-test time is a legitimate finding, not a smoke
// failure, so this never calls fail() on a mismatch by itself).

const GHCR_REGISTRY_HOST = "ghcr.io";

interface ParsedGhcrImageRef {
  repository: string;
  tag: string;
}

function parseGhcrImageRef(image: string): ParsedGhcrImageRef | null {
  const prefix = `${GHCR_REGISTRY_HOST}/`;
  if (!image.startsWith(prefix)) return null;
  const rest = image.slice(prefix.length);
  const colonIndex = rest.lastIndexOf(":");
  if (colonIndex <= 0 || colonIndex === rest.length - 1) return null;
  const repository = rest.slice(0, colonIndex);
  const tag = rest.slice(colonIndex + 1);
  if (!repository || !tag) return null;
  return { repository, tag };
}

async function fetchGhcrManifestDigest(ref: ParsedGhcrImageRef): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const tokenRes = await fetch(
      `https://${GHCR_REGISTRY_HOST}/token?service=${GHCR_REGISTRY_HOST}&scope=repository:${ref.repository}:pull`,
      { signal: controller.signal }
    );
    if (!tokenRes.ok) {
      throw new Error(`GHCR token request HTTP ${tokenRes.status}`);
    }
    const tokenBody = (await tokenRes.json()) as { token?: string };
    if (!tokenBody.token) {
      throw new Error("GHCR token response missing 'token' field");
    }

    const manifestRes = await fetch(
      `https://${GHCR_REGISTRY_HOST}/v2/${ref.repository}/manifests/${ref.tag}`,
      {
        method: "HEAD",
        headers: {
          Authorization: `Bearer ${tokenBody.token}`,
          Accept: [
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
            "application/vnd.oci.image.index.v1+json",
          ].join(", "),
        },
        signal: controller.signal,
      }
    );
    if (!manifestRes.ok) {
      throw new Error(`GHCR manifest HEAD HTTP ${manifestRes.status}`);
    }
    const digest = manifestRes.headers.get("docker-content-digest");
    if (!digest) {
      throw new Error("GHCR manifest response missing docker-content-digest header");
    }
    return digest;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchDeployedDigest(serviceId: string): Promise<string | null> {
  const query = `
    query ($serviceId: String!) {
      service(id: $serviceId) {
        deployments(first: 1) {
          edges { node { meta } }
        }
      }
    }
  `;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RAILWAY_TIMEOUT_MS);

  try {
    const res = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${railwayToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { serviceId } }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: {
        service?: {
          deployments?: { edges?: { node: { meta?: { imageDigest?: string } | null } }[] };
        };
      };
    };
    const meta = body.data?.service?.deployments?.edges?.[0]?.node.meta;
    return meta?.imageDigest ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runDigestLagPhase(services: DiscoveredService[]): Promise<void> {
  console.log("\nPhase 4: GHCR digest-lag mechanism (mt#3251)");
  console.log("-".repeat(50));

  const imageTargets = services.filter(
    (s): s is DiscoveredService & { image: string } => s.image !== null && s.serviceId !== ""
  );

  if (imageTargets.length === 0) {
    skip("digest-lag", "No image-source services found in deploy.config.ts files");
    return;
  }

  for (const target of imageTargets) {
    const parsedRef = parseGhcrImageRef(target.image);
    if (!parsedRef) {
      fail(`digest-lag:${target.name}`, `Could not parse configured image "${target.image}"`);
      continue;
    }

    let registryDigest: string;
    try {
      registryDigest = await fetchGhcrManifestDigest(parsedRef);
    } catch (err) {
      fail(`digest-lag:${target.name}`, `GHCR manifest lookup failed: ${err}`);
      continue;
    }
    pass(`digest-lag-reachable:${target.name}`, `Registry digest: ${registryDigest}`);

    if (!railwayToken) {
      continue;
    }

    const deployedDigest = await fetchDeployedDigest(target.serviceId);
    if (!deployedDigest) {
      skip(
        `digest-lag-compare:${target.name}`,
        "Railway deployment has no meta.imageDigest to compare (or the API call failed)"
      );
      continue;
    }
    if (verbose) {
      console.log(`    [${target.name}] deployed=${deployedDigest} registry=${registryDigest}`);
    }
    // Informational only: a real lag here is a legitimate production
    // finding, not a smoke-test defect, so this reports via pass() either
    // way — the mechanism (both digests fetched successfully) is what's
    // under test, not the current freshness state.
    pass(
      `digest-lag-compare:${target.name}`,
      deployedDigest === registryDigest
        ? "Deployed digest matches registry (up to date)"
        : `Deployed digest LAGS registry (deployed=${deployedDigest}, registry=${registryDigest})`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== smoke-post-deploy-health-monitor (mt#1302) ===");
  console.log(`Railway token: ${railwayToken ? "present" : "absent (deploy checks skipped)"}`);
  console.log(`Verbose: ${verbose}`);

  // Discover services from deploy.config.ts files (mirrors production monitor).
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  let services: DiscoveredService[];
  try {
    services = await discoverServices(repoRoot);
    console.log(`Discovered ${services.length} services from services/*/deploy.config.ts`);
  } catch (err) {
    console.error(`FATAL: service discovery failed: ${err}`);
    process.exit(1);
  }

  await runHealthPhase(services);
  await runRailwayPhase(services);
  runDeduplicationPhase(services);
  await runDigestLagPhase(services);

  // Summary.
  const passing = results.filter((r) => r.status === "pass").length;
  const failing = results.filter((r) => r.status === "fail").length;
  const skipping = results.filter((r) => r.status === "skip").length;

  console.log("\n=== Results ===");
  console.log(`  Pass: ${passing}`);
  console.log(`  Fail: ${failing}`);
  console.log(`  Skip: ${skipping}`);
  console.log(`  Total: ${results.length}`);

  if (failing > 0) {
    console.error("\nSome checks failed:");
    for (const r of results.filter((r) => r.status === "fail")) {
      console.error(`  FAIL  ${r.name}: ${r.detail}`);
    }
    // Exit 1 if smoke failures are real failures (health not reachable in prod).
    // If you're running this from a restricted network, some probes may fail
    // for connectivity reasons unrelated to service health.
    process.exit(1);
  }

  if (skipping > 0 && passing === 0) {
    console.log("\nAll checks skipped (missing env vars).");
    process.exit(2);
  }

  console.log("\nAll checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke script unexpectedly crashed:", err);
  process.exit(1);
});
