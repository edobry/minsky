#!/usr/bin/env bun
/**
 * Post-deploy outcome + health monitor (mt#1302).
 *
 * Checks every deployed Railway service for:
 *   (a) Latest deploy terminal status — alerts on FAILED / CRASHED.
 *       Catches the mt#1991 build-failure class.
 *   (b) GET <service>/health returns 200 — alerts on non-200 / timeout.
 *       Catches the mt#2345 runtime-crash-after-green-build class.
 *   (c) Deployed image digest lags the newest registry digest (mt#3251) —
 *       alerts when the running deployment's image (per Railway's own
 *       `meta.imageDigest`) does not match the newest manifest digest for
 *       the configured `ghcr.io` tag. Catches the "HEALTHY but FROZEN"
 *       class: a service that is up and answering 200 on an OLD image
 *       because its deploy pipeline silently stopped shipping new ones
 *       (the mt#3251 incident — reviewer deploys failed for ~2 days while
 *       /health stayed green throughout). Only applies to image-source
 *       deploys (a service whose deploy.config.ts sets
 *       `railway.source.image`); repo-source deploys have no registry tag
 *       to compare against — see "Does NOT cover" below.
 *
 * ### Covers (check (c), mt#3251)
 *
 *   - A service's deploy pipeline silently failing to ship new images to
 *     production while the service itself stays healthy (the mt#3251
 *     class), regardless of WHY the pipeline stalled — CI failure, a
 *     stale/wrong credential, a forgotten manual step, a webhook miss.
 *     The check compares what's LIVE against what's NEWEST in the
 *     registry directly, rather than trusting the pipeline's own
 *     self-reported status.
 *   - Any current or future image-source-deployed service, automatically —
 *     service discovery already walks every services/<svc>/deploy.config.ts
 *     at runtime (see discoverServices below), so a new image-source
 *     service is covered with no code change here.
 *   - Multi-arch (index/manifest-list) registry tags (mt#3251 R1 hardening).
 *     Railway's `meta.imageDigest` is always the PLATFORM-SPECIFIC digest it
 *     pulled, which does not equal a multi-arch index's own digest — the
 *     comparison logic (fetchGhcrManifest / checkService) detects the index
 *     shape and matches against the index digest OR any per-platform child
 *     digest, not just the index digest alone. Both images this monitor
 *     currently watches are single-platform (verified live 2026-07-28), so
 *     this is defensive coverage for a shape that would otherwise
 *     false-positive forever, not an active bug fix.
 *
 * ### Does NOT cover (check (c), mt#3251)
 *
 *   - Repo-source (build-from-Railway) deployed services — cockpit
 *     (RAILPACK) and site (NIXPACKS) as of this writing. There is no
 *     registry image tag to compare against for these; freshness for
 *     that deploy shape is not verified by this check. No current owner —
 *     file a follow-up task if a "repo-source service frozen" incident
 *     motivates one.
 *   - minsky-ops — skipped like all other checks (empty serviceId).
 *   - Whether the NEWEST registry image was built from the CORRECT source
 *     commit. This check only verifies "did the newest pushed image reach
 *     Railway," not "was the right code built into that image."
 *   - A multi-arch index whose `manifests` array cannot be parsed into any
 *     per-platform digest (mt#3251 R1). Rather than guess and risk a
 *     permanent false positive, this degrades to a logged, non-alerting
 *     "cannot compare" skip — the same fail-open discipline as any other
 *     lookup failure in this check.
 *   - A brief false-positive window right after a new image is pushed but
 *     before the redeploy step has had time to run (the digests
 *     legitimately differ for a few minutes). A single 10-minute-cadence
 *     check can catch this transiently; a SUSTAINED lag across multiple
 *     runs is the real signal, matching this monitor's existing
 *     de-dup/update-not-duplicate behavior for other alert classes.
 *   - An operator deliberately rolling back to an older image. This
 *     check has no way to distinguish an intentional rollback from an
 *     unintentional freeze — both alert. Consistent with this monitor's
 *     existing philosophy elsewhere (a dismissable false alarm beats a
 *     missed freeze).
 *   - Private GHCR packages. The registry lookup uses the ANONYMOUS
 *     token flow (verified live during mt#3251 against both
 *     ghcr.io/edobry/minsky and ghcr.io/edobry/minsky-reviewer, which are
 *     public). If package visibility is later changed to private, the
 *     registry fetch will fail and this check degrades to a logged
 *     warning (see fetchGhcrManifest's caller in checkService) —
 *     it does NOT alert on that failure, since a lookup failure is not
 *     evidence of a digest lag.
 *
 * Primary alert:   Open / update a GitHub P0 issue per service+failure-class.
 *                  De-duped so a sustained outage updates ONE issue, not N.
 * Secondary alert: POST an asks_create coordination.notify over hosted MCP
 *                  (best-effort; wrapped in try/catch so its failure NEVER
 *                  suppresses the primary path).
 *
 * SERVICE DISCOVERY (mt#1302 R1 fix):
 *   Services are discovered at runtime by enumerating services/<svc>/deploy.config.ts
 *   (glob: services/[star]/deploy.config.ts) and importing each one via Bun's
 *   native .ts dynamic import. The service list, serviceIds, and healthUrls are
 *   all read from those config files — NEVER hardcoded in this script. Adding or
 *   removing a service requires only updating its deploy.config.ts; this script
 *   needs no changes.
 *
 *   A service is SKIPPED when its railway.serviceId is empty (the standard
 *   "not yet provisioned" convention — e.g., minsky-ops). This is exclusion by
 *   data, not by name-based special-casing.
 *
 *   Source of truth for healthUrl: services/<svc>/deploy.config.ts (healthUrl
 *   field on the DeploymentConfig). See packages/shared/src/deployment/config.ts.
 *   Source of truth for the digest-lag check's registry tag: the same file's
 *   `railway.source.image` field, when present.
 *
 * USAGE (in GitHub Actions):
 *   RAILWAY_TOKEN=... GITHUB_TOKEN=... GITHUB_REPO=edobry/minsky bun scripts/post-deploy-health-monitor.ts
 *
 * USAGE (local dry-run — no RAILWAY_TOKEN needed, skips Railway checks):
 *   DRY_RUN=true GITHUB_TOKEN=... GITHUB_REPO=edobry/minsky bun scripts/post-deploy-health-monitor.ts
 *
 * ENV VARS:
 *   RAILWAY_TOKEN          — Railway API token (read access). Skip Railway
 *                            checks when absent (graceful degradation). Also
 *                            gates the digest-lag check (c), which needs the
 *                            deployed digest from the same Railway call.
 *   GITHUB_TOKEN           — GitHub PAT or Actions token with issues:write.
 *   GITHUB_REPO            — "owner/repo" (e.g. "edobry/minsky").
 *   MINSKY_MCP_AUTH_TOKEN  — Bearer token for hosted MCP (secondary path).
 *                            When absent, secondary path is skipped.
 *   DRY_RUN                — "true" to log only; no GitHub issues or MCP calls.
 *
 * SECRETS:
 *   RAILWAY_TOKEN, MINSKY_MCP_AUTH_TOKEN, GITHUB_TOKEN are consumed from env.
 *   None are logged or embedded in outputs. The GHCR registry lookup for
 *   check (c) needs no secret — it uses GHCR's anonymous registry-token flow.
 *
 * Architecture: external to all monitored services; runs on GitHub Actions.
 * See .github/workflows/post-deploy-health-monitor.yml for the host.
 */

import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
// Relative import: this script runs from the non-package `scripts/` context on
// a GitHub Actions runner, where the `@minsky/domain/*` workspace alias is not
// guaranteed to resolve (same rationale as scripts/smoke-retrigger-default-url.ts).
import {
  assertServiceIdentity,
  describeHealthIdentityResult,
  identityForServiceDir,
  type ServiceIdentity,
} from "../packages/domain/src/deployment/health-identity";

// ---------------------------------------------------------------------------
// Service definitions — discovered at runtime from deploy.config.ts files
// ---------------------------------------------------------------------------

interface ServiceDef {
  /** Human-readable name used in issue titles and log output. */
  name: string;
  /** Railway serviceId. Empty string = not provisioned yet — skip gracefully. */
  serviceId: string;
  /** HTTP URL for the health endpoint. Null = no HTTP health check. */
  healthUrl: string | null;
  /**
   * mt#3251 — configured GHCR image ref for image-source deploys (e.g.
   * "ghcr.io/edobry/minsky-reviewer:latest"), read from deploy.config.ts's
   * `railway.source.image`. Null for repo-source deploys (cockpit, site) —
   * the digest-lag check has no registry tag to compare against for those.
   */
  image: string | null;
}

/**
 * Discover all deployed services by walking services/<svc>/deploy.config.ts
 * (glob: services/[star]/deploy.config.ts) and importing each one (Bun supports
 * direct .ts dynamic imports). The service list, serviceIds, and healthUrls are
 * read from the config files — not hardcoded here.
 *
 * This is the runtime realisation of the spec/PR/docs claim that the monitor runs
 * "for each service with a provisioned deploy.config.ts serviceId". A service with
 * an empty serviceId is excluded by data (not by name), matching the convention
 * in services/minsky-ops/deploy.config.ts.
 *
 * Source of truth for health URLs: the `healthUrl` field of each DeploymentConfig.
 * See packages/shared/src/deployment/config.ts.
 */
async function discoverServices(repoRoot: string): Promise<ServiceDef[]> {
  const servicesDir = join(repoRoot, "services");

  let serviceNames: string[];
  try {
    serviceNames = readdirSync(servicesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    throw new Error(`Failed to enumerate services directory at ${servicesDir}: ${err}`);
  }

  const discovered: ServiceDef[] = [];

  for (const name of serviceNames) {
    const configPath = join(servicesDir, name, "deploy.config.ts");

    let mod: { default?: unknown };
    try {
      mod = (await import(configPath)) as { default?: unknown };
    } catch {
      // No deploy.config.ts for this directory — skip silently.
      continue;
    }

    const cfg = mod.default;
    if (!cfg || typeof cfg !== "object" || !("platform" in cfg) || !("railway" in cfg)) {
      console.warn(`[discovery] ${name}/deploy.config.ts has unexpected shape — skipping`);
      continue;
    }

    const railway = (cfg as { railway: Record<string, unknown> }).railway;
    const serviceId = typeof railway["serviceId"] === "string" ? railway["serviceId"] : "";
    const healthUrl =
      "healthUrl" in cfg ? ((cfg as { healthUrl?: string | null }).healthUrl ?? null) : null;

    // mt#3251 — extract the configured image ref (image-source deploys only).
    // `railway.source.image` is a string on image-source configs (reviewer,
    // minsky-mcp); repo-source configs (`source.repo` + `build`) have no
    // `image` field, so this resolves to null for them.
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
  meta?: {
    commitHash?: string;
    commitMessage?: string;
    /**
     * mt#3251 — present on image-source deploys (verified live against the
     * minsky-reviewer-webhook service: this field's value matched GHCR's
     * `docker-content-digest` for the same tag exactly). The resolved
     * digest of the image Railway actually pulled for this deployment.
     */
    imageDigest?: string;
    /** mt#3251 — the image ref Railway resolved, e.g. "ghcr.io/edobry/minsky-reviewer:latest". */
    image?: string;
  } | null;
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
// GHCR registry digest lookup (mt#3251, check (c) — "healthy but frozen")
// ---------------------------------------------------------------------------
//
// Fetches the newest manifest for a ghcr.io image tag using the anonymous
// Docker Registry v2 token flow — no secret required. Verified live during
// mt#3251 against both ghcr.io/edobry/minsky and ghcr.io/edobry/minsky-reviewer
// (both public packages): the returned docker-content-digest matched
// Railway's own `meta.imageDigest` for the currently-deployed image exactly,
// confirming both the mechanism and the field names used here are correct,
// not merely plausible.
//
// MULTI-ARCH HARDENING (mt#3251 R1 reviewer finding). A tag can resolve to
// either a single-platform image manifest OR a multi-arch index/manifest-list
// (a small JSON document whose `manifests` array lists one child manifest
// digest per platform). Railway's `meta.imageDigest` is always the
// PLATFORM-SPECIFIC digest it actually pulled — for a multi-arch tag, that
// digest does NOT equal the index's own digest, so comparing against the
// index digest alone would false-positive forever. Verified live (2026-07-28)
// that both images this monitor currently watches
// (ghcr.io/edobry/minsky-reviewer:latest, ghcr.io/edobry/minsky:latest) are
// SINGLE-PLATFORM manifests today (mediaType
// application/vnd.docker.distribution.manifest.v2+json, no `manifests`
// array) — so this is defensive hardening for a shape that does not
// reproduce in this repo currently, not a fix for an active defect. Fetching
// the manifest BODY (GET, not HEAD) is what makes the index case detectable
// at all — a HEAD-only digest, as this function did before R1, cannot see
// the `mediaType`/`manifests` fields needed to tell the two shapes apart.

const GHCR_REGISTRY_HOST = "ghcr.io";
const GHCR_TIMEOUT_MS = 10_000;
const MANIFEST_ACCEPT_HEADER = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
].join(", ");

/** Media types that mark a manifest response as a multi-arch index/manifest-list. */
const GHCR_INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

interface ParsedGhcrImageRef {
  repository: string;
  tag: string;
}

/**
 * Parse an image ref of the form "ghcr.io/<owner>/<name>:<tag>". Returns
 * null for anything not hosted on ghcr.io — this monitor only knows how to
 * look up GHCR digests; a future non-GHCR image-source config would need
 * its own lookup, not a silent mis-parse of this one.
 */
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

/** Result of fetching a GHCR manifest, with enough shape info to compare correctly. */
interface GhcrManifestResult {
  /** The digest of the top-level fetched document (an index digest for a multi-arch tag). */
  digest: string;
  /** True when the fetched document is a multi-arch index/manifest-list. */
  isIndex: boolean;
  /**
   * Per-platform child digests, populated only when isIndex is true and the
   * body's `manifests` array parsed cleanly. A deployed digest matching ANY
   * of these (or the index digest itself) counts as "up to date".
   */
  childDigests: string[];
}

/**
 * Fetch a GHCR image tag's manifest via the anonymous registry-token flow,
 * returning enough shape information to compare correctly against a
 * platform-specific deployed digest (see GhcrManifestResult). Throws on any
 * failure (network, non-200, missing header, unparseable body) — the caller
 * treats a thrown error as "cannot determine," NOT as "digest matches" (see
 * checkService: a lookup failure logs a warning and skips the alert, it
 * never asserts "OK" by default).
 */
async function fetchGhcrManifest(ref: ParsedGhcrImageRef): Promise<GhcrManifestResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GHCR_TIMEOUT_MS);

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

    // GET, not HEAD: the body is required to detect a multi-arch index (its
    // `mediaType` / `manifests` fields are invisible to a headers-only HEAD
    // request).
    const manifestRes = await fetch(
      `https://${GHCR_REGISTRY_HOST}/v2/${ref.repository}/manifests/${ref.tag}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenBody.token}`,
          Accept: MANIFEST_ACCEPT_HEADER,
        },
        signal: controller.signal,
      }
    );
    if (!manifestRes.ok) {
      throw new Error(`GHCR manifest GET HTTP ${manifestRes.status}`);
    }
    const digest = manifestRes.headers.get("docker-content-digest");
    if (!digest) {
      throw new Error("GHCR manifest response missing docker-content-digest header");
    }

    const bodyText = await manifestRes.text();
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch (err) {
      throw new Error(
        `GHCR manifest response body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const mediaType =
      body &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>)["mediaType"] === "string"
        ? ((body as Record<string, unknown>)["mediaType"] as string)
        : null;
    const manifestsField =
      body &&
      typeof body === "object" &&
      Array.isArray((body as Record<string, unknown>)["manifests"])
        ? ((body as Record<string, unknown>)["manifests"] as unknown[])
        : [];

    const isIndex =
      (mediaType !== null && GHCR_INDEX_MEDIA_TYPES.has(mediaType)) || manifestsField.length > 0;
    const childDigests = isIndex
      ? manifestsField
          .map((m) =>
            m &&
            typeof m === "object" &&
            typeof (m as Record<string, unknown>)["digest"] === "string"
              ? ((m as Record<string, unknown>)["digest"] as string)
              : null
          )
          .filter((d): d is string => d !== null)
      : [];

    return { digest, isIndex, childDigests };
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
  /**
   * mt#3148: set when the `service` identity could not be confirmed. A
   * `wrong-service` result ALSO sets `ok: false` + `error`; a `missing-identity`
   * result sets only this, so it is reported without paging.
   */
  identityWarning: string | null;
  error: string | null;
}

async function probeHealth(
  url: string,
  expectedIdentity: ServiceIdentity | null = null
): Promise<HealthProbeResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const bodyText = await res.text().catch(() => "");
    // Limit snippet to 200 chars to keep issue bodies readable.
    // eslint-disable-next-line custom/no-unsafe-string-truncation -- HTTP health response bodies are ASCII (JSON, plain text status)
    const bodySnippet = bodyText.slice(0, 200);

    // mt#3148: a 200 is necessary but NOT sufficient. Every service here is
    // built from the same monorepo, so a misconfigured build can put a
    // DIFFERENT application on this host — and it will answer 200 (mt#3142:
    // the MCP server served the reviewer's host for ~1h while every reviewer
    // route 404'd, and this monitor stayed green throughout).
    //
    // The two identity failure modes are deliberately NOT treated alike:
    //
    //  - `wrong-service` — a different Minsky app is deployed here. This is the
    //    mt#3142 class and is a hard FAILURE.
    //  - `missing-identity` — no `service` key. Expected transiently for any
    //    service that has not redeployed since mt#3148 merged, so it is
    //    surfaced as a WARNING, not an alert. This monitor opens a P0 GitHub
    //    issue every 10 minutes; failing on absence would page continuously
    //    during rollout for services that are perfectly healthy. Tightening
    //    this to a hard failure once all four services carry the field is
    //    tracked as a follow-up.
    let identityWarning: string | null = null;
    let identityFailed = false;
    if (expectedIdentity && res.status === 200) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = bodyText;
      }
      const identity = assertServiceIdentity(parsed, expectedIdentity);
      if (!identity.ok) {
        if (identity.reason === "wrong-service") {
          identityFailed = true;
        }
        identityWarning = describeHealthIdentityResult(identity);
      }
    }

    return {
      ok: res.status === 200 && !identityFailed,
      statusCode: res.status,
      bodySnippet,
      identityWarning,
      error: identityFailed ? `Wrong application deployed on this host — ${identityWarning}` : null,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      statusCode: null,
      bodySnippet: "",
      identityWarning: null,
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

/**
 * Find an existing open issue by title in the repo.
 * Returns null when none found.
 *
 * Strategy (mt#1302 R1 fix — label-search fallback):
 *   1. Primary: label-filtered /search/issues with exact title match. This is
 *      the fast path and works when the label was applied successfully.
 *   2. Fallback: list open issues via GET /repos/{owner}/{repo}/issues?state=open
 *      and match by exact title. This catches the case where the monitor label
 *      wasn't created/applied (e.g. label creation failed) OR when the search
 *      index is lagging (GitHub's search index can be seconds to minutes behind
 *      real state, which can produce duplicate issues during outage bursts).
 *
 * Title-exact matching is applied in both paths — label-search can return
 * fuzzy title matches, and list pagination returns all open issues.
 */
async function findOpenIssue(
  repo: string,
  title: string,
  token: string
): Promise<GitHubIssue | null> {
  // --- Primary path: label-filtered search ---
  try {
    const encoded = encodeURIComponent(
      `repo:${repo} is:open is:issue label:${MONITOR_LABEL} in:title "${title}"`
    );
    const results = await githubRequest<{ items: GitHubIssue[] }>(
      "GET",
      `/search/issues?q=${encoded}&per_page=5`,
      token
    );
    // Exact-match the title in case search is fuzzy.
    const found = results.items.find((i) => i.title === title) ?? null;
    if (found) return found;
  } catch (err) {
    // Log but fall through to the list-based fallback.
    console.warn(`[github] label-search for "${title}" failed (falling back to list): ${err}`);
  }

  // --- Fallback: list open issues and match by exact title ---
  // This handles: label not created/applied, search index lag, rate-limit on search.
  // Paginate up to 3 pages (300 issues) — enough for any realistic open-issue count.
  const MAX_FALLBACK_PAGES = 3;
  for (let page = 1; page <= MAX_FALLBACK_PAGES; page++) {
    let issues: GitHubIssue[];
    try {
      issues = await githubRequest<GitHubIssue[]>(
        "GET",
        `/repos/${repo}/issues?state=open&per_page=100&page=${page}`,
        token
      );
    } catch (err) {
      console.warn(`[github] fallback issue list (page ${page}) failed: ${err}`);
      break;
    }

    const found = issues.find((i) => i.title === title) ?? null;
    if (found) return found;

    // GitHub returns fewer than per_page items on the last page.
    if (issues.length < 100) break;
  }

  return null;
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
  failureClass: "deploy-failed" | "health-down" | "digest-lag",
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
  /** mt#3251 — true when the deployed image digest lags the registry's newest. */
  digestLagAlert: boolean;
  /** mt#3251 — digest Railway reports for the currently-deployed image. */
  deployedDigest: string | null;
  /** mt#3251 — newest manifest digest for the configured tag in the registry. */
  registryDigest: string | null;
  /** mt#3251 — set when the check could not run/complete; never implies "OK". */
  digestLagError: string | null;
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
      digestLagAlert: false,
      deployedDigest: null,
      registryDigest: null,
      digestLagError: null,
      skipped: true,
      skipReason: "serviceId not provisioned",
    };
  }

  // --- (a) Railway deploy status ---
  let deployStatus: string | null = null;
  let deployId: string | null = null;
  let deployCreatedAt: string | null = null;
  let deployAlert = false;
  // Kept outside the try block so check (c) below can reuse the already-
  // fetched deployment's `meta.imageDigest` instead of a second Railway call.
  let deployment: RailwayDeploymentNode | null = null;

  if (railwayToken) {
    try {
      deployment = await fetchLatestDeployment(svc.serviceId, railwayToken);
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
    // mt#3148: resolve the expected identity from the service DIRECTORY name
    // (they differ — `services/cockpit` emits `minsky-cockpit`). Null for a
    // service with no identifiable endpoint, which skips the assertion rather
    // than failing it.
    const probe = await probeHealth(svc.healthUrl, identityForServiceDir(svc.name));
    healthOk = probe.ok;
    healthStatus = probe.statusCode;
    healthError = probe.error;
    healthAlert = !probe.ok;
  }

  // --- (c) Digest-lag check (mt#3251) ---
  // Only applies to image-source deploys (svc.image set from deploy.config.ts's
  // railway.source.image). See the module doc-comment's "Does NOT cover" list
  // for what this deliberately does not check.
  let digestLagAlert = false;
  let deployedDigest: string | null = null;
  let registryDigest: string | null = null;
  let digestLagError: string | null = null;

  if (svc.image) {
    if (!deployment) {
      // No Railway data to compare against — either RAILWAY_TOKEN is absent
      // or check (a) already failed and logged its own warning above. Either
      // way this is "cannot determine," not "OK": no alert is raised, but the
      // gap is visible in the console log via digestLagError.
      digestLagError = railwayToken
        ? "No Railway deployment data available — cannot compare digests"
        : "SKIPPED (no RAILWAY_TOKEN)";
    } else {
      const parsedRef = parseGhcrImageRef(svc.image);
      deployedDigest = deployment.meta?.imageDigest ?? null;

      if (!parsedRef) {
        digestLagError = `Configured image "${svc.image}" is not a recognized ghcr.io ref — skipping digest-lag check`;
      } else if (!deployedDigest) {
        digestLagError =
          "Railway deployment meta has no imageDigest to compare against (older deployments predate this field)";
      } else {
        try {
          const manifest = await fetchGhcrManifest(parsedRef);
          registryDigest = manifest.digest;

          if (!manifest.isIndex) {
            // Single-platform manifest (the shape both currently-watched
            // images actually have, verified live 2026-07-28): direct
            // comparison.
            digestLagAlert = registryDigest !== deployedDigest;
          } else if (manifest.childDigests.length === 0) {
            // mt#3251 R1 hardening: detected a multi-arch index/manifest-list
            // but could not extract any per-platform child digest to compare
            // against (unexpected/unparseable `manifests` entries). Railway's
            // digest is platform-specific and will almost never equal the
            // index's own digest, so comparing against `registryDigest`
            // alone here would false-positive on every check. Prefer a
            // missed detection over a permanent false alarm on an alerting
            // path — skip with a logged reason instead of guessing.
            digestLagError =
              "Registry tag resolved to a multi-arch index with no extractable per-platform digests — cannot compare, skipping";
          } else {
            // Multi-arch index WITH extractable child digests: the deployed
            // digest is expected to match one of the PLATFORM manifests, not
            // the index itself, but accept either — a match against the
            // index digest is also legitimate if Railway ever resolves and
            // stores the index digest directly.
            const candidates = new Set([manifest.digest, ...manifest.childDigests]);
            digestLagAlert = !candidates.has(deployedDigest);
          }
        } catch (err) {
          console.warn(`[${svc.name}] GHCR digest lookup failed: ${err}`);
          // Non-fatal, same discipline as (a): a lookup failure is not
          // evidence of a lag, so it must never alert.
          digestLagError = err instanceof Error ? err.message : String(err);
        }
      }
    }
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
    digestLagAlert,
    deployedDigest,
    registryDigest,
    digestLagError,
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

function formatDigestLagDetails(svc: ServiceDef, result: CheckResult): string {
  return [
    `- **Service:** \`${svc.name}\``,
    `- **Configured image:** \`${svc.image ?? "unknown"}\``,
    `- **Deployed digest:** \`${result.deployedDigest ?? "unknown"}\``,
    `- **Newest registry digest:** \`${result.registryDigest ?? "unknown"}\``,
    `- **Deploy status (for context):** \`${result.deployStatus ?? "unknown"}\``,
    "",
    "**What this means:** the service is running an OLDER image than the newest one pushed " +
      "to the registry. The service may be perfectly HEALTHY — this alert catches the case " +
      "where the deploy pipeline silently stopped shipping new images while the running " +
      "instance stays up (mt#3251).",
    "",
    "**Action:** check the service's deploy workflow run history for recent failures, fix the " +
      "underlying cause, then manually trigger a redeploy.",
  ].join("\n");
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

  // Discover services dynamically from services/*/deploy.config.ts.
  // The script lives in <repo>/scripts/; go up one level for the repo root.
  // import.meta.dir is set by Bun when running a .ts file directly.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  let services: ServiceDef[];
  try {
    services = await discoverServices(repoRoot);
  } catch (err) {
    console.error(`FATAL: service discovery failed: ${err}`);
    process.exit(1);
  }

  console.log(`=== post-deploy-health-monitor (mt#1302) ===`);
  console.log(`Repo: ${githubRepo}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Railway token: ${railwayToken ? "present" : "absent"}`);
  console.log(`MCP auth token: ${mcpAuthToken ? "present" : "absent"}`);
  console.log(`Discovered ${services.length} services (from services/*/deploy.config.ts)...\n`);

  let totalAlerts = 0;

  for (const svc of services) {
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
    if (svc.image) {
      const digestStatus = result.digestLagAlert
        ? "LAG"
        : result.digestLagError
          ? `SKIP (${result.digestLagError})`
          : "OK";
      console.log(
        `  Digest:        deployed=${result.deployedDigest ?? "?"} registry=${result.registryDigest ?? "?"} — ${digestStatus}`
      );
    }

    const alerts: Array<{
      class: "deploy-failed" | "health-down" | "digest-lag";
      details: string;
    }> = [];

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

    if (result.digestLagAlert) {
      alerts.push({
        class: "digest-lag",
        details: formatDigestLagDetails(svc, result),
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
