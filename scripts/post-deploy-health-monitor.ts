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
 * A fourth alert class, `check-failed`, fires when any of (a)/(b)/(c) could
 * not COMPLETE (mt#3921) — the credential is wrong-scoped, the registry is
 * unreachable, a response will not parse. A service with an unrunnable check
 * is DEGRADED, not HEALTHY, because the monitor has observed nothing about
 * it. Scoring lives in packages/domain/src/deployment/monitor-verdict.ts,
 * which carries the full rule and the incident that produced it.
 *
 * ### Covers (check-failed, mt#3921)
 *
 *   - Any credential, network, or parse failure that prevents a check from
 *     running, on any service, including the fleet-wide case: the five
 *     services span four Railway projects, so one wrong-scoped token blinds
 *     all of them at once, which is exactly what happened for 4.5 days.
 *   - A monitor deployed with NO Railway credential at all.
 *
 * ### Does NOT cover (check-failed, mt#3921)
 *
 *   - A check that runs and returns a WRONG answer (a stale Railway record,
 *     a registry serving a cached manifest). This class detects checks that
 *     cannot run, not checks that lie. No current owner — file a task if
 *     such an incident occurs.
 *   - The monitor workflow failing to run at all (a cancelled schedule, a
 *     broken `bun install`, GitHub Actions downtime). Nothing inside this
 *     script can observe its own absence; that gap belongs to whatever
 *     watches the workflow's run history. No current owner.
 *   - Alert DELIVERY. This class decides an alert is warranted; whether it
 *     reaches the operator is the primary GitHub-issue path plus the
 *     secondary cockpit-ask path, and the latter is separately broken —
 *     mt#2782 owns it.
 *
 * ### Covers (P0 resolution, mt#3963)
 *
 *   - Retiring an escalated P0 once its failure class is observed RECOVERED —
 *     the detecting check RAN and found no problem — continuously for at least
 *     P0_RECOVERY_MIN_SUSTAINED_INTERVAL_MS. All four alert classes, every
 *     service, including P0s opened before this path existed (they carry no
 *     recovery marker, so the next run marks them and the one after closes).
 *   - A service that recovers, is marked, then breaks again inside the window:
 *     alertViaGitHubIssue CLEARS the recovery marker whenever it updates an open
 *     issue, so the clock restarts rather than closing a live alert.
 *   - Not touching issues this monitor did not open: resolution requires both
 *     the P0 and monitor labels AND the monitor's own body signature.
 *
 * ### Does NOT cover (P0 resolution, mt#3963)
 *
 *   - Closing a P0 whose class this run could not CHECK. An unrunnable check has
 *     observed nothing, so it is not evidence of recovery — the P0 stays open
 *     and a check-failed alert fires alongside it. Intentional, and the reason
 *     resolution reads per-check outcomes rather than "no alert fired".
 *   - Reopening. A closed P0 is never reopened; a recurrence opens a NEW issue.
 *     Deliberate — an issue's close is an operator-visible event, and reusing
 *     one would erase the boundary between two distinct outages.
 *   - The secondary cockpit-ask alert channel. Nothing retires an ask raised by
 *     this monitor; mt#2782 owns that path and it is separately broken.
 *   - A P0 opened by this monitor whose LABELS were removed by hand. It is
 *     invisible to the resolver's one bulk lookup and stays open forever. Failing
 *     closed in the safe direction; no current owner.
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
 *   - The transient in-flight-deploy window (mt#3251 R2 hardening, refined
 *     mt#3284). A healthy build+push+redeploy cycle leaves the registry
 *     ahead of the deployed digest for a few minutes; at a 10-minute check
 *     cadence, every normal deploy has a real chance of landing inside one
 *     check. This check does NOT alert on a single observation —
 *     resolveDigestLagSustained requires the SAME (deployedDigest,
 *     registryDigest) pair to be observed again AND at least
 *     DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS of wall-clock time to have
 *     elapsed since the FIRST observation (tracked via a non-P0 "pending"
 *     GitHub issue, since the monitor itself is stateless between runs)
 *     before escalating. Counting observations alone is not enough — two
 *     manual `workflow_dispatch` runs seconds apart satisfy "two runs" as
 *     trivially as a real freeze does (mt#3284: this produced a false
 *     positive P0, issue #2363, during mt#3251's own live verification). A
 *     real freeze (this task's own incident: ~2 days) survives the
 *     elapsed-time requirement trivially; a routine deploy (~2-5 minutes)
 *     does not, and nor does a rapid re-invocation.
 *
 * ### Does NOT cover (check (c), mt#3251)
 *
 *   - Repo-source (build-from-Railway) deployed services — cockpit
 *     (RAILPACK) and site (NIXPACKS) as of this writing. There is no
 *     registry image tag to compare against for these; freshness for
 *     that deploy shape is not verified by this check. No current owner —
 *     file a follow-up task if a "repo-source service frozen" incident
 *     motivates one.
 *     (minsky-ops is NOT in this category: it was provisioned with an
 *     image-source config sharing minsky-mcp's project, so check (c) applies
 *     to it. This line previously claimed it was skipped for an empty
 *     serviceId — corrected mt#3921.)
 *   - Whether the NEWEST registry image was built from the CORRECT source
 *     commit. This check only verifies "did the newest pushed image reach
 *     Railway," not "was the right code built into that image."
 *   - A multi-arch index whose `manifests` array cannot be parsed into any
 *     per-platform digest (mt#3251 R1). Rather than guess and risk a
 *     permanent false `digest-lag` positive, this never claims a lag.
 *     It does NOT pass silently either (mt#3921): like any other lookup
 *     failure here it marks the check `failed`, which raises a
 *     `check-failed` alert saying the digest could not be compared. The two
 *     classes answer different questions — "is this service on a stale
 *     image?" versus "can this monitor tell?" — and only the first would be
 *     a false alarm.
 *   - An operator deliberately rolling back to an older image. This
 *     check has no way to distinguish an intentional rollback from an
 *     unintentional freeze — both alert (after the sustained-check above
 *     confirms the SAME pair persists for at least the configured minimum
 *     elapsed time, mt#3284 — not merely across two runs regardless of how
 *     close together in time they were). Consistent with this monitor's
 *     existing philosophy elsewhere (a dismissable false alarm beats a
 *     missed freeze).
 *   - Private GHCR packages. The registry lookup uses the ANONYMOUS
 *     token flow (verified live during mt#3251 against both
 *     ghcr.io/edobry/minsky and ghcr.io/edobry/minsky-reviewer, which are
 *     public). If package visibility is later changed to private, the
 *     registry fetch will fail and this check degrades to a logged
 *     warning (see fetchGhcrManifest's caller in checkService). It never
 *     alerts `digest-lag` on that failure, since a lookup failure is not
 *     evidence of a lag — but as of mt#3921 it does alert `check-failed`,
 *     because a check that cannot reach the registry is not one that passed.
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
 *   "not yet provisioned" convention). This is exclusion by data, not by
 *   name-based special-casing. As of mt#3921 no service is in that state —
 *   all five carry a serviceId, so all five are checked.
 *
 *   Source of truth for healthUrl: services/<svc>/deploy.config.ts (healthUrl
 *   field on the DeploymentConfig). See packages/shared/src/deployment/config.ts.
 *   Source of truth for the digest-lag check's registry tag: the same file's
 *   `railway.source.image` field, when present.
 *
 * USAGE (in GitHub Actions):
 *   RAILWAY_TOKEN=... GITHUB_TOKEN=... GITHUB_REPO=edobry/minsky bun scripts/post-deploy-health-monitor.ts
 *
 * USAGE (local dry-run — runnable without RAILWAY_TOKEN, but every service
 * will read DEGRADED, since the Railway-dependent checks cannot run):
 *   DRY_RUN=true GITHUB_TOKEN=... GITHUB_REPO=edobry/minsky bun scripts/post-deploy-health-monitor.ts
 *
 * ENV VARS:
 *   RAILWAY_TOKEN          — Railway ACCOUNT or WORKSPACE token (read access);
 *                            in CI it is fed from the RAILWAY_MCP_TOKEN secret.
 *                            Also gates the digest-lag check (c), which needs
 *                            the deployed digest from the same Railway call.
 *                            **Its absence is NOT graceful degradation
 *                            (mt#3921):** both checks are then marked `failed`,
 *                            every affected service is DEGRADED, and a
 *                            check-failed alert fires. A monitor with no
 *                            credential is blind, and says so.
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
// mt#3921 — the verdict scorer lives outside this file because this file calls
// main() at module scope; a test cannot import it without running the monitor.
import {
  scoreService,
  type AlertClass,
  type CheckOutcome,
  type CheckSummary,
  type ServiceCheckSummary,
} from "../packages/domain/src/deployment/monitor-verdict";
// mt#1495 — check (d)'s decision: what a service's DB-pool recovery counters
// mean. Same split and the same reason as the two imports around it.
import {
  readRecycleCounters,
  toRecoveryCheckSummary,
} from "../packages/domain/src/deployment/monitor-recovery-alarm";
// mt#3963 — likewise for the resolution side: which classes a run observed as
// recovered, and whether that recovery has been sustained long enough to close
// the P0 it opened.
import {
  decideP0Resolution,
  formatP0SubjectMarker,
  isMonitorAuthoredP0,
  matchesP0Subject,
  observedRecoveredClasses,
  parseP0RecoveryMarker,
  stripP0RecoveryMarker,
  withP0RecoveryMarker,
} from "../packages/domain/src/deployment/monitor-p0-resolution";

// mt#2782: the secondary alert channel's decisions — coalesce, payload shape,
// and reading the response as an OUTCOME rather than a transport status.
import { runAskAlert } from "../packages/domain/src/deployment/monitor-ask-alert";

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
 * an empty serviceId is excluded by data (not by name). minsky-ops was the
 * example of that convention when this comment was written and no longer is —
 * it now carries a serviceId and is checked like the rest (mt#3921).
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
 * checkService: a lookup failure logs a warning and never raises `digest-lag`,
 * since it is not evidence of a lag — but as of mt#3921 it marks the check
 * `failed`, which raises `check-failed`. It never asserts "OK" by default).
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
  /**
   * The response body parsed as JSON, or `null` when it was absent/unparseable
   * (mt#1495).
   *
   * Deliberately NOT derived from `bodySnippet`: that is capped at 200 chars for
   * issue-body readability, so anything past the first couple of fields is gone.
   * Check (d) reads `dbRecycle`, which sits well beyond that cap on the cockpit's
   * payload — parsing the snippet would have silently reported "no counters
   * present" for a service that publishes them.
   */
  parsedBody: unknown;
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
    // Parsed once, here, and shared by the identity assertion below and check (d)
    // (mt#1495). `parsedJson` stays null on a non-JSON body so check (d) can tell
    // "not JSON" from "JSON without dbRecycle"; the identity assertion keeps its
    // original behaviour of falling back to the raw text, which it handles.
    let parsedJson: unknown = null;
    try {
      parsedJson = JSON.parse(bodyText);
    } catch {
      parsedJson = null;
    }

    let identityWarning: string | null = null;
    let identityFailed = false;
    if (expectedIdentity && res.status === 200) {
      const identity = assertServiceIdentity(parsedJson ?? bodyText, expectedIdentity);
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
      parsedBody: parsedJson,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      statusCode: null,
      bodySnippet: "",
      identityWarning: null,
      error: isTimeout ? `Timeout after ${HEALTH_TIMEOUT_MS}ms` : String(err),
      parsedBody: null,
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
  /**
   * Present ONLY on pull requests. GitHub's issues endpoints return PRs
   * alongside issues, so this field is how a listing tells them apart.
   */
  pull_request?: unknown;
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
function issueTitle(serviceName: string, failureClass: AlertClass): string {
  // A Record, not a ternary chain (mt#1495). The chain this replaces ended in a
  // bare `: "Deployed image digest lags registry"` default, so adding a fifth
  // AlertClass silently titled it as a digest lag — and since the title is the
  // de-duplication key, two different failure classes would have collapsed onto
  // one P0 issue. `Record<AlertClass, string>` makes the same omission a compile
  // error instead.
  const CLASS_LABELS: Record<AlertClass, string> = {
    "deploy-failed": "Deploy FAILED/CRASHED",
    "health-down": "Health check DOWN",
    "check-failed": "Monitor checks could not run — service state UNKNOWN",
    "digest-lag": "Deployed image digest lags registry",
    "recovery-degraded": "DB-pool recovery is stranding connections",
  };
  return `[P0] ${serviceName}: ${CLASS_LABELS[failureClass]}`;
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
  for (const label of [P0_LABEL, MONITOR_LABEL, DIGEST_LAG_PENDING_LABEL]) {
    try {
      await githubRequest("GET", `/repos/${repo}/labels/${encodeURIComponent(label)}`, token);
    } catch {
      // Label doesn't exist — create it.
      try {
        await githubRequest("POST", `/repos/${repo}/labels`, token, {
          name: label,
          color:
            label === P0_LABEL
              ? "B60205"
              : label === DIGEST_LAG_PENDING_LABEL
                ? "FBCA04"
                : "0075CA",
          description:
            label === P0_LABEL
              ? "P0 outage: service is down or deploy failed"
              : label === DIGEST_LAG_PENDING_LABEL
                ? "Pending digest-lag observation (mt#3251, mt#3284) — a lag was seen once but has not yet persisted long enough (see DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS) to be a confirmed sustained lag"
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
  failureClass: AlertClass,
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
    "*Resolves automatically once the condition clears and stays clear (mt#3963);" +
      " close by hand to mute it sooner.*",
    // mt#3963 — stable identity for the resolver, so retitling this issue
    // cannot strand it open.
    formatP0SubjectMarker(serviceName, failureClass),
  ].join("\n");

  if (dryRun) {
    console.log(`[dry-run] Would open/update GitHub issue: "${title}"`);
    console.log(`[dry-run] Body:\n${body}`);
    return "(dry-run — no issue URL)";
  }

  // Ensure labels exist before trying to use them (idempotent).
  await ensureLabelsExist(repo, token);

  // Asymmetry with resolveP0IfRecovered, deliberate (mt#3963 R1). This lookup
  // is still exact-title, so a retitled open P0 is not found here and a NEW one
  // is opened beside it. That degrades LOUDLY — the operator gets a fresh,
  // correctly-titled P0 the monitor can manage — whereas the same brittleness
  // on the closing side degraded SILENTLY, leaving an alert open forever with
  // nothing to notice. Only the silent direction was worth the added matching.
  const existing = await findOpenIssue(repo, title, token);
  if (existing) {
    // mt#3963 — the service is failing AGAIN, so any recovery marker left by an
    // earlier healthy run is stale and must be cleared. Without this, a service
    // that recovers, is marked, then breaks again inside the sustained-recovery
    // window would be closed by a later run reading that stale marker — the
    // alert silently retired while the condition holds.
    if (parseP0RecoveryMarker(existing.body) !== null) {
      try {
        await githubRequest("PATCH", `/repos/${repo}/issues/${existing.number}`, token, {
          body: stripP0RecoveryMarker(existing.body),
        });
        console.log(
          `[github] Cleared stale recovery marker on #${existing.number} — ${serviceName}/${failureClass} is failing again.`
        );
      } catch (err) {
        // Non-fatal for THIS call (the recurrence comment below still lands),
        // but log loudly: a marker that survives here is the one way a live
        // failure could be auto-closed.
        console.error(
          `[github] ERROR clearing recovery marker on #${existing.number} (a stale marker can auto-close a LIVE alert): ${err}`
        );
      }
    }

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
// Digest-lag sustained-check (mt#3251 R2, elapsed-time hardening mt#3284) —
// cross-run pending tracker
// ---------------------------------------------------------------------------
//
// The digest-lag check (c) can legitimately fire transiently: a healthy
// build+push+redeploy cycle leaves `registryDigest != deployedDigest` for a
// few minutes while the redeploy is still in flight. At a 10-minute check
// cadence, EVERY normal deploy has a real chance of landing inside that
// window — alerting on a single observation would page on routine, healthy
// operation, exactly the alert-fatigue class the R1 review flagged for the
// multi-arch case and R2 flagged for this one.
//
// This monitor is stateless between runs (a fresh process each schedule
// tick), so "sustained" is tracked via a lightweight, NON-P0 GitHub issue —
// reusing the same substrate the P0 alerts already use as a persistence
// layer, rather than standing up new infrastructure. On the FIRST
// observation of a given (deployedDigest, registryDigest) pair for a
// service, this records the pair AND the observation timestamp on a
// "pending" tracker issue and does NOT alert.
//
// mt#3284: counting observations alone is NOT sufficient — R2's original
// "two consecutive runs" condition counts RUNS, not ELAPSED TIME, so two
// `workflow_dispatch` invocations seconds apart satisfy it exactly as well
// as a real multi-day freeze. That gap produced a real false positive
// (issue #2363) during mt#3251's own live verification: two manual runs
// ~20s apart escalated a P0 against a service that had deployed
// successfully ~10 minutes earlier. Escalation now additionally requires
// DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS of wall-clock time to have elapsed
// since the FIRST observation, read back from the pending tracker issue's
// body — the monitor is still stateless between runs, so that timestamp
// has to be persisted and parsed back exactly like the digest pair already
// was. A real freeze survives this trivially (this task's own incident
// lasted ~2 days; the post-unstick re-drift persisted 30+ minutes in R1's
// live evidence); a normal deploy cycle (~2-5 minutes) does not, and
// neither does a rapid re-invocation.

/** Label for the cross-run pending-observation tracker issues. Distinct from P0_LABEL. */
const DIGEST_LAG_PENDING_LABEL = "digest-lag-pending";

/**
 * mt#3284 — minimum wall-clock time that must elapse between the FIRST and
 * a LATER observation of the same (deployedDigest, registryDigest) pair
 * before the sustained-check escalates to a P0. Two runs close together in
 * time (e.g. two manual `workflow_dispatch` invocations ~20s apart) satisfy
 * the "same pair observed again" condition trivially without the lag
 * actually being SUSTAINED in wall-clock terms — this is exactly what
 * produced the false positive in issue #2363 during mt#3251's own live
 * verification.
 *
 * Set deliberately just UNDER the workflow's normal 10-minute cron cadence
 * (.github/workflows/post-deploy-health-monitor.yml's `*\/10 * * * *`
 * schedule) so a normal scheduled pair still satisfies this threshold on
 * the very next tick with no added delay — the threshold only rejects runs
 * that are ABNORMALLY close together (manual re-invocations), never the
 * routine 10-minute cadence.
 */
const DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes

function pendingTrackerTitle(serviceName: string): string {
  return `[pending] ${serviceName}: digest-lag observation (not yet escalated)`;
}

/** Machine-parseable marker line embedded in a pending tracker issue's body. */
function formatPendingPairMarker(deployedDigest: string, registryDigest: string): string {
  return `PENDING_DIGEST_PAIR: ${deployedDigest}|${registryDigest}`;
}

const PENDING_PAIR_RE = /PENDING_DIGEST_PAIR:\s*(\S+)\|(\S+)/;

function parsePendingPairMarker(
  body: string | null
): { deployed: string; registry: string } | null {
  if (!body) return null;
  const match = PENDING_PAIR_RE.exec(body);
  if (!match) return null;
  const [, deployed, registry] = match;
  if (!deployed || !registry) return null;
  return { deployed, registry };
}

/**
 * mt#3284 — machine-parseable marker for the FIRST-OBSERVATION timestamp,
 * persisted alongside the digest pair so a later run can read back WHEN the
 * lag was first seen and measure elapsed wall-clock time, not just count
 * runs.
 */
function formatPendingFirstObservedMarker(firstObservedAtIso: string): string {
  return `PENDING_DIGEST_FIRST_OBSERVED_AT: ${firstObservedAtIso}`;
}

const PENDING_FIRST_OBSERVED_RE = /PENDING_DIGEST_FIRST_OBSERVED_AT:\s*(\S+)/;

/** Returns the ISO timestamp string, or null if absent/unparseable as a date. */
function parsePendingFirstObservedMarker(body: string | null): string | null {
  if (!body) return null;
  const match = PENDING_FIRST_OBSERVED_RE.exec(body);
  if (!match) return null;
  const [, isoString] = match;
  if (!isoString || Number.isNaN(Date.parse(isoString))) return null;
  return isoString;
}

/**
 * mt#3284 — pure decision function: has enough wall-clock time elapsed
 * between `nowMs` and the pair's FIRST-OBSERVATION timestamp to treat the
 * lag as genuinely SUSTAINED (rather than two runs that merely happened to
 * land close together)? Extracted as a pure, I/O-free function specifically
 * so the smoke test (scripts/smoke-post-deploy-health-monitor.ts) can
 * exercise this exact decision logic without needing live GitHub state.
 */
function isDigestLagSustainedByElapsedTime(nowMs: number, firstObservedAtIso: string): boolean {
  const elapsedMs = nowMs - Date.parse(firstObservedAtIso);
  return elapsedMs >= DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS;
}

/** Builds the pending-tracker issue body, embedding both machine-parseable markers. */
function buildPendingTrackerBody(
  serviceName: string,
  firstObservedAtIso: string,
  deployedDigest: string,
  registryDigest: string
): string {
  const minutes = DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS / 60_000;
  return [
    "## Digest-lag pending observation (mt#3251)",
    "",
    `Tracking a POSSIBLE digest lag for \`${serviceName}\` — NOT YET escalated.`,
    `Escalation requires the SAME deployed/registry digest pair to be observed`,
    `again AND at least ${minutes} minutes to have elapsed since the first`,
    "observation below (mt#3284) — not just a second consecutive run. This",
    "issue closes automatically once the state resolves (digest catches up)",
    "or escalates.",
    "",
    `**First observed at:** ${firstObservedAtIso}`,
    "",
    formatPendingPairMarker(deployedDigest, registryDigest),
    formatPendingFirstObservedMarker(firstObservedAtIso),
    "",
    "---",
    "*Auto-managed by [post-deploy-health-monitor](.github/workflows/post-deploy-health-monitor.yml)" +
      " (mt#3251, mt#3284). Do not edit the PENDING_DIGEST_PAIR /" +
      " PENDING_DIGEST_FIRST_OBSERVED_AT lines by hand.*",
  ].join("\n");
}

/**
 * Decide whether a detected digest-lag should escalate to a real P0 alert
 * this run, using a cross-run pending-tracker issue as the persistence
 * layer. Returns `escalate: true` only when the SAME (deployedDigest,
 * registryDigest) pair has been observed on a LATER run AND at least
 * DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS has elapsed since the pair's first
 * observation (mt#3284) — a later run alone is not sufficient.
 *
 * Fails CLOSED on any GitHub API error along the way (logs a warning, never
 * escalates) — the same "prefer inconclusive over false alarm" discipline
 * this check applies to the multi-arch-index case (mt#3251 R1).
 */
async function resolveDigestLagSustained(
  repo: string,
  token: string,
  serviceName: string,
  deployedDigest: string,
  registryDigest: string,
  dryRun: boolean
): Promise<{ escalate: boolean; note: string }> {
  if (dryRun) {
    // Dry-run has no cross-run persistence within a single invocation, so
    // treating every dry-run detection as a first observation (never
    // escalating) is the only correct behavior — it cannot know whether a
    // PRIOR real run already observed the same pair.
    console.log(
      `[dry-run] Would check/update the digest-lag pending tracker for ${serviceName} (dry-run never escalates — no real cross-run state).`
    );
    return { escalate: false, note: "dry-run: first-observation-only, no persisted state" };
  }

  const title = pendingTrackerTitle(serviceName);

  let existing: GitHubIssue | null = null;
  try {
    existing = await findOpenIssue(repo, title, token);
  } catch (err) {
    console.warn(`[${serviceName}] digest-lag pending-tracker lookup failed: ${err}`);
    return { escalate: false, note: "pending-tracker lookup failed — treating as inconclusive" };
  }

  const now = new Date();
  const timestamp = now.toISOString();

  if (!existing) {
    // First observation ever for this service — record both the pair and
    // the observation timestamp so a later run can measure elapsed time.
    const body = buildPendingTrackerBody(serviceName, timestamp, deployedDigest, registryDigest);
    try {
      await ensureLabelsExist(repo, token);
      const created = await githubRequest<GitHubIssue>("POST", `/repos/${repo}/issues`, token, {
        title,
        body,
        labels: [DIGEST_LAG_PENDING_LABEL, MONITOR_LABEL],
      });
      console.log(
        `[github] Opened pending digest-lag tracker #${created.number} for ${serviceName} (first observation, not alerting).`
      );
    } catch (err) {
      console.warn(`[${serviceName}] could not create digest-lag pending tracker: ${err}`);
    }
    return { escalate: false, note: "first observation — pending tracker created, no alert" };
  }

  const recorded = parsePendingPairMarker(existing.body);
  const samePair =
    recorded !== null &&
    recorded.deployed === deployedDigest &&
    recorded.registry === registryDigest;

  if (samePair) {
    const recordedFirstObservedAt = parsePendingFirstObservedMarker(existing.body);

    if (!recordedFirstObservedAt) {
      // Same pair, but no parseable first-observed marker (e.g. a
      // pre-mt#3284 tracker body). Fail closed: reset as a fresh
      // observation rather than guessing an elapsed time that could
      // wrongly satisfy the interval check.
      console.warn(
        `[${serviceName}] pending tracker #${existing.number} has no parseable first-observed marker — resetting as a fresh observation`
      );
      const body = buildPendingTrackerBody(serviceName, timestamp, deployedDigest, registryDigest);
      try {
        await githubRequest("PATCH", `/repos/${repo}/issues/${existing.number}`, token, { body });
      } catch (err) {
        console.warn(
          `[${serviceName}] could not refresh pending tracker #${existing.number}: ${err}`
        );
      }
      return {
        escalate: false,
        note: "same pair but missing first-observed marker — reset to fresh observation",
      };
    }

    if (isDigestLagSustainedByElapsedTime(now.getTime(), recordedFirstObservedAt)) {
      // Same pair, AND enough wall-clock time has passed since the first
      // observation — genuinely sustained. Escalate. Close the pending
      // tracker; the real [P0] issue (opened by the caller right after
      // this returns) is now the persistent record.
      try {
        await githubRequest("PATCH", `/repos/${repo}/issues/${existing.number}`, token, {
          state: "closed",
        });
      } catch (err) {
        // Non-fatal: escalation proceeds either way — a lingering pending
        // issue is a cosmetic cleanup gap, not a correctness problem.
        console.warn(
          `[${serviceName}] could not close pending tracker #${existing.number}: ${err}`
        );
      }
      const elapsedSec = Math.round((now.getTime() - Date.parse(recordedFirstObservedAt)) / 1000);
      return {
        escalate: true,
        note: `sustained: same pair, ${elapsedSec}s since first observation (>= ${DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS / 1000}s threshold) — escalating (was pending issue #${existing.number})`,
      };
    }

    // Same pair, but not enough elapsed time yet — deliberately do NOT
    // refresh the tracker's first-observed timestamp (mt#3284). Refreshing
    // it here would push escalation off forever under a fast repeat-
    // invocation cadence, since every observation would reset the clock.
    // Leave the tracker exactly as-is and wait for a later run.
    const elapsedSec = Math.round((now.getTime() - Date.parse(recordedFirstObservedAt)) / 1000);
    return {
      escalate: false,
      note: `same pair observed again after only ${elapsedSec}s (< ${DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS / 1000}s threshold) — waiting for sustained elapsed time (pending issue #${existing.number})`,
    };
  }

  // Pending tracker exists but records a DIFFERENT pair — the state moved
  // (another push landed mid-window, or a prior lag resolved and a new one
  // began). Treat as a fresh first observation: refresh the tracker (new
  // pair + new first-observed timestamp), do not escalate yet.
  const body = buildPendingTrackerBody(serviceName, timestamp, deployedDigest, registryDigest);
  try {
    await githubRequest("PATCH", `/repos/${repo}/issues/${existing.number}`, token, { body });
  } catch (err) {
    console.warn(`[${serviceName}] could not refresh pending tracker #${existing.number}: ${err}`);
  }
  return {
    escalate: false,
    note: "pending pair changed since last observation — reset to first observation",
  };
}

/**
 * Close a lingering digest-lag pending tracker when the check no longer
 * observes a lag (it resolved before reaching a sustained escalation — the
 * correct, no-false-alarm outcome). Best-effort: a failure here is a
 * cosmetic cleanup gap only.
 */
async function closeDigestLagPendingTracker(
  repo: string,
  token: string,
  serviceName: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun) return;
  const title = pendingTrackerTitle(serviceName);
  let existing: GitHubIssue | null = null;
  try {
    existing = await findOpenIssue(repo, title, token);
  } catch (err) {
    console.warn(`[${serviceName}] pending-tracker lookup (for cleanup) failed: ${err}`);
    return;
  }
  if (!existing) return;
  try {
    await githubRequest("PATCH", `/repos/${repo}/issues/${existing.number}`, token, {
      state: "closed",
    });
    console.log(
      `[github] Closed resolved digest-lag pending tracker #${existing.number} for ${serviceName}.`
    );
  } catch (err) {
    console.warn(
      `[${serviceName}] could not close resolved pending tracker #${existing.number}: ${err}`
    );
  }
}

// ---------------------------------------------------------------------------
// P0 resolution (mt#3963) — the exit this recovery layer did not have
// ---------------------------------------------------------------------------
//
// Everything above can RAISE an alert; until mt#3963 nothing could retire one.
// `closeDigestLagPendingTracker` closes only the `[pending]` tracker, and that
// tracker's own body promises the behavior the P0 it escalates INTO lacked:
// "This issue closes automatically once the state resolves or escalates."
//
// The decisions live in packages/domain/src/deployment/monitor-p0-resolution.ts
// (pure, unit-tested); this is the IO shell.

/**
 * Every open, labeled P0 CONSIDERED for resolution, fetched ONCE per run.
 *
 * Deliberately not a per-(service, class) `findOpenIssue` call: four classes
 * across five services is 20 lookups per run, each of which can fall back to
 * three pages of issue listing — an N+1 against a 10-minute cron
 * (`efficient-database-queries.mdc`). The label filter is an AND, so this
 * returns only issues carrying BOTH the P0 and monitor labels; anything else is
 * not ours to close, and an unlabeled monitor issue simply is not auto-resolved
 * (failing closed, in the direction that leaves an issue open).
 *
 * This is a CANDIDATE set, not a verified-authorship set — labels can be
 * applied by hand. `resolveP0IfRecovered` checks the monitor's body signature
 * before touching anything.
 *
 * Pull requests are dropped: GitHub's issues endpoints return PRs too, and a
 * labeled PR would otherwise reach the subject match.
 */
async function listOpenMonitorP0s(repo: string, token: string): Promise<GitHubIssue[]> {
  const MAX_PAGES = 3;
  const collected: GitHubIssue[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    let issues: GitHubIssue[];
    try {
      issues = await githubRequest<GitHubIssue[]>(
        "GET",
        `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(`${P0_LABEL},${MONITOR_LABEL}`)}&per_page=100&page=${page}`,
        token
      );
    } catch (err) {
      // Inconclusive, not empty: log so a persistent lookup failure is visible
      // rather than reading as "no P0s to resolve".
      console.warn(`[github] open-P0 listing (page ${page}) failed: ${err}`);
      break;
    }

    collected.push(...issues.filter((issue) => issue.pull_request === undefined));
    // Page size is measured BEFORE the PR filter — a page that was full of PRs
    // is still a full page, and stopping there would truncate the listing.
    if (issues.length < 100) break;
  }

  return collected;
}

/**
 * Close the open P0 for (service, failureClass) once this run has observed the
 * condition recovered for long enough — or record the first such observation.
 *
 * Only called for a class `observedRecoveredClasses` reports as recovered with
 * positive evidence, so "no alert this run" alone can never close an issue.
 */
async function resolveP0IfRecovered(
  repo: string,
  token: string,
  openP0s: GitHubIssue[],
  serviceName: string,
  failureClass: AlertClass,
  runRef: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun) return;

  // mt#3963 R1 — identify by the body's subject marker, falling back to a
  // TOLERANT title match for P0s opened before that marker existed. Exact title
  // equality would mean an operator who retitles an issue mid-incident strands
  // it open forever, which is the defect this whole path exists to end.
  const canonicalTitle = issueTitle(serviceName, failureClass);
  const existing = openP0s.find((issue) =>
    matchesP0Subject(issue, { service: serviceName, failureClass, canonicalTitle })
  );
  if (!existing) return;

  // SC3 — resolve only issues this monitor opened. The label filter above is
  // one guard; the body signature is the stronger one, since a label can be
  // applied by hand to somebody else's incident.
  if (!isMonitorAuthoredP0(existing.body)) {
    console.log(
      `[github] P0 #${existing.number} (${serviceName}/${failureClass}) carries no monitor signature — leaving it alone.`
    );
    return;
  }

  const now = new Date();
  const decision = decideP0Resolution({
    recoveryFirstObservedAtIso: parseP0RecoveryMarker(existing.body),
    nowMs: now.getTime(),
  });

  if (decision.action === "wait") {
    console.log(`  P0 #${existing.number} (${failureClass}) recovery: ${decision.note}`);
    return;
  }

  if (decision.action === "mark") {
    try {
      await githubRequest("PATCH", `/repos/${repo}/issues/${existing.number}`, token, {
        body: withP0RecoveryMarker(existing.body, now.toISOString()),
      });
      console.log(`  P0 #${existing.number} (${failureClass}) recovery: ${decision.note}`);
    } catch (err) {
      // Best-effort: a failed mark means the close is deferred to a later run,
      // never that a live alert is closed.
      console.warn(`[${serviceName}] could not record recovery on P0 #${existing.number}: ${err}`);
    }
    return;
  }

  // action === "close"
  const comment = [
    `**Resolved** as of ${now.toISOString()}.`,
    "",
    `\`${serviceName}\` / \`${failureClass}\` has been observed healthy by ${runRef}, and ${decision.note}.`,
    "",
    "Closed automatically by [post-deploy-health-monitor](.github/workflows/post-deploy-health-monitor.yml) (mt#3963).",
    "If the condition returns, the monitor opens a new P0 rather than reusing this one.",
  ].join("\n");

  try {
    await githubRequest("POST", `/repos/${repo}/issues/${existing.number}/comments`, token, {
      body: comment,
    });
  } catch (err) {
    // The comment is the audit trail for the close; without it, close anyway —
    // a silently-closed issue beats a permanently-stale one — but say so.
    console.warn(
      `[${serviceName}] could not comment on P0 #${existing.number} before closing: ${err}`
    );
  }

  try {
    await githubRequest("PATCH", `/repos/${repo}/issues/${existing.number}`, token, {
      state: "closed",
    });
    console.log(
      `[github] Closed resolved P0 #${existing.number} (${serviceName}/${failureClass}) — ${decision.note}.`
    );
  } catch (err) {
    console.warn(`[${serviceName}] could not close resolved P0 #${existing.number}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Secondary alert: MCP asks_create (best-effort)
// ---------------------------------------------------------------------------

const MINSKY_MCP_URL = "https://minsky-mcp-production.up.railway.app/mcp";
const MCP_TIMEOUT_MS = 15_000;

async function alertViaMcp(
  mcpAuthToken: string,
  service: string,
  failureClass: string,
  subject: string,
  details: string
): Promise<void> {
  // JSON-RPC asks_create over HTTP MCP (mt#2782).
  //
  // This path had never created an ask AND logged "sent successfully" every
  // time, because it checked only the HTTP status — a JSON-RPC error comes back
  // as 200 with an `error` member. Three things changed:
  //   1. the registered tool name, not the Claude Code harness prefix;
  //   2. declared params only (title/question/metadata), not subject/body/priority;
  //   3. success is the RETURNED ASK ID. `parseAskCreateResponse` treats an
  //      accepted call that created nothing as a failure, which is the case
  //      "it didn't throw" cannot see.
  // It also coalesces, so a sustained outage does not open one ask per 10-minute
  // tick. Decisions live in the domain module; the fetches stay here.
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

    const callTool = async (id: number, name: string, args: object): Promise<unknown> => {
      const res = await fetch(MINSKY_MCP_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mcpAuthToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Still checked — a transport failure is a real failure. It is just no
        // longer treated as the ONLY way this can fail.
        throw new Error(`MCP ${name} HTTP ${res.status}`);
      }
      // Deliberately untyped at this boundary: the two parsers in
      // monitor-ask-alert.ts take `unknown` and do the narrowing, which is where
      // the shape assertions are tested. Typing it here would be a claim about
      // the wire format that nothing checks.
      const parsed: unknown = await res.json();
      return parsed;
    };

    // List -> decide -> create -> verify. The sequence lives in the domain
    // module so it is testable end-to-end with an injected caller (PR #2888 R1);
    // this shell owns only the session and the JSON-RPC envelope.
    let nextRequestId = 2;
    const result = await runAskAlert({
      callTool: (name, args) => callTool(nextRequestId++, name, args),
      service,
      failureClass,
      subject,
      details,
    });

    if (result.outcome === "coalesced") {
      console.log(
        `[mcp] asks_create skipped — ask ${result.existingAskId} is already open for ` +
          `${service}/${failureClass} (coalesced)`
      );
      return;
    }

    console.log(`[mcp] asks_create created ask ${result.askId} for ${service}/${failureClass}`);
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
  /**
   * mt#3921 — the three-state per-check outcomes the verdict scorer reads.
   * The booleans above say whether a check that RAN found a problem; this says
   * whether it ran at all. Scoring the first without the second is what let a
   * fleet-wide credential failure report five HEALTHY services for 4.5 days.
   */
  summary: ServiceCheckSummary;
}

/** mt#3921 — a check that does not apply to this service by design. */
function notApplicableCheck(detail: string) {
  return { outcome: "not-applicable" as CheckOutcome, detail, problem: false };
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
      summary: {
        service: svc.name,
        deploy: notApplicableCheck("serviceId not provisioned"),
        health: notApplicableCheck("serviceId not provisioned"),
        digest: notApplicableCheck("serviceId not provisioned"),
        recovery: notApplicableCheck("serviceId not provisioned"),
      },
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

  // mt#3921 — `failed` means the check could not run, which is NOT a pass.
  let deployOutcome: CheckOutcome = "ok";
  let deployDetail: string | null = null;

  if (railwayToken) {
    try {
      deployment = await fetchLatestDeployment(svc.serviceId, railwayToken);
      if (deployment) {
        deployStatus = deployment.status;
        deployId = deployment.id;
        deployCreatedAt = deployment.createdAt;
        deployAlert = FAILED_TERMINAL_STATUSES.has(deployment.status);
        deployDetail = `latest deployment ${deployment.id} is ${deployment.status}`;
      } else {
        deployStatus = "NO_DEPLOYMENTS";
        deployDetail = "Railway reports no deployments for this service";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${svc.name}] Railway deploy check failed: ${message}`);
      // Non-fatal for the sweep — the health check below still runs — but the
      // check itself did not complete, so it contributes an alert rather than
      // silently counting as a pass.
      deployStatus = `ERROR: ${message}`;
      deployOutcome = "failed";
      deployDetail = message;
    }
  } else {
    // No credential is "I cannot look," not "nothing to look at."
    deployStatus = "COULD-NOT-RUN (no RAILWAY_TOKEN)";
    deployOutcome = "failed";
    deployDetail = "RAILWAY_TOKEN is not set — the monitor has no Railway credential";
  }

  // --- (b) HTTP /health probe ---
  let healthOk = true;
  let healthStatus: number | null = null;
  let healthAlert = false;
  let healthError: string | null = null;

  // A service with no configured health endpoint has nothing to probe — that
  // is a design fact, not a failure to observe one.
  const healthOutcome: CheckOutcome = svc.healthUrl ? "ok" : "not-applicable";
  let healthDetail: string | null = svc.healthUrl ? null : "no healthUrl configured";
  /** The parsed /health body, reused by check (d) below (mt#1495). */
  let healthBody: unknown = null;

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
    healthBody = probe.parsedBody;
    // An unreachable endpoint is an observation, not an unrunnable check: the
    // probe ran and the service failed to answer.
    healthDetail = probe.ok
      ? `HTTP ${probe.statusCode}`
      : (probe.error ?? `HTTP ${probe.statusCode ?? "timeout"}`);
  }

  // --- (d) DB-pool recovery counters (mt#1495) ---
  // Reads `dbRecycle` off the SAME body check (b) already fetched — no extra
  // request, no extra credential. Only the cockpit publishes these today, so for
  // every other service this resolves to `not-applicable` and is silent.
  //
  // Gated on the health probe having actually answered: when (b) failed there is
  // no body to read, and reporting (d) as its own unrunnable check would raise a
  // second alert for one underlying fault. The `check-failed` class de-dups per
  // service, but the detail would name a consequence as if it were a cause.
  const recoverySummary: CheckSummary = !svc.healthUrl
    ? {
        outcome: "not-applicable",
        detail: "no healthUrl configured — nothing to read counters from",
        problem: false,
      }
    : !healthOk
      ? {
          outcome: "not-applicable",
          detail: "health probe did not answer — check (b) owns this failure",
          problem: false,
        }
      : toRecoveryCheckSummary(readRecycleCounters(healthBody));

  // --- (c) Digest-lag check (mt#3251) ---
  // Only applies to image-source deploys (svc.image set from deploy.config.ts's
  // railway.source.image). See the module doc-comment's "Does NOT cover" list
  // for what this deliberately does not check.
  let digestLagAlert = false;
  let deployedDigest: string | null = null;
  let registryDigest: string | null = null;
  let digestLagError: string | null = null;
  // mt#3921 — a repo-source service has no registry tag to compare against, so
  // the check genuinely does not apply. Every other non-`ok` path below is a
  // check that DOES apply and could not complete.
  let digestOutcome: CheckOutcome = svc.image ? "ok" : "not-applicable";
  let digestDetail: string | null = svc.image
    ? null
    : "repo-source service — no configured image to compare";

  if (svc.image) {
    if (!deployment) {
      // No Railway data to compare against — either RAILWAY_TOKEN is absent
      // or check (a) already failed and logged its own warning above. Either
      // way this is "cannot determine," not "OK". Until mt#3921 that meant a
      // console line and nothing else, which is how a fleet-wide credential
      // failure produced five HEALTHY services; it is now an unrunnable check
      // and alerts as such.
      digestLagError = railwayToken
        ? "No Railway deployment data available — cannot compare digests"
        : // The console line already wraps this in COULD-NOT-RUN(…), so this
          // carries the reason alone rather than repeating the label.
          "no RAILWAY_TOKEN — the monitor has no Railway credential";
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
          // evidence of a lag, so it never raises `digest-lag`. It is
          // recorded as an unrunnable check, which raises `check-failed`
          // downstream (mt#3921).
          digestLagError = err instanceof Error ? err.message : String(err);
        }
      }
    }
  }

  // Every `digestLagError` set inside the block above is a check that applies
  // to this service and could not complete — an auth failure, an unparseable
  // registry response, a missing digest field. `not-applicable` is set once,
  // at declaration, for the only case that is a design fact (no image).
  if (svc.image && digestLagError) {
    digestOutcome = "failed";
    digestDetail = digestLagError;
  } else if (digestOutcome === "ok") {
    digestDetail = `deployed=${deployedDigest ?? "?"} registry=${registryDigest ?? "?"}`;
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
    summary: {
      service: svc.name,
      deploy: { outcome: deployOutcome, detail: deployDetail, problem: deployAlert },
      health: { outcome: healthOutcome, detail: healthDetail, problem: healthAlert },
      digest: { outcome: digestOutcome, detail: digestDetail, problem: digestLagAlert },
      recovery: recoverySummary,
    },
  };
}

// ---------------------------------------------------------------------------
// Format alert details
// ---------------------------------------------------------------------------

/**
 * mt#3921 — one or more checks could not run, so this service's state is
 * UNKNOWN. Distinct from the three "we looked and found a problem" classes:
 * the operator's action is to repair the monitor, not the service.
 */
function formatCheckFailedDetails(svc: ServiceDef, result: CheckResult, reason: string): string {
  return [
    `- **Service:** \`${svc.name}\``,
    `- **Why:** ${reason}`,
    "",
    "**This is not a report that the service is down.** It is a report that the",
    "monitor could not determine whether it is. Until these checks run, this",
    "service is unmonitored — treat a green run as carrying no information.",
    "",
    "**Common cause:** the Railway credential is wrong-scoped for this service's",
    "project, or (for a locally-run monitor) an expired CLI access token — the",
    "API answers `Not Authorized` for both, so read the detail above rather than",
    "assuming which. A Railway *project* token cannot authenticate this call at",
    "all: the GraphQL request sends `Authorization: Bearer`, which per Railway's",
    "public-API reference is the account/workspace-token header.",
    "",
    `**Observed:** deploy=\`${result.summary.deploy.outcome}\` health=\`${result.summary.health.outcome}\` digest=\`${result.summary.digest.outcome}\``,
    `**Railway service ID:** \`${svc.serviceId}\``,
  ].join("\n");
}

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

/**
 * P0 body for check (d) — the DB-pool recovery mechanism reported a failed
 * teardown (mt#1495).
 *
 * Takes no `CheckResult`: unlike its three siblings, everything this alert knows
 * is already in `reason`, which `monitor-recovery-alarm.ts` renders from the
 * counters themselves (how many recycles, how many abandoned, when the last one
 * was). Threading the result through only to ignore it would suggest there is
 * more context available here than there is.
 */
function formatRecoveryDegradedDetails(svc: ServiceDef, reason: string): string {
  return [
    `- **Service:** \`${svc.name}\``,
    `- **Health URL:** \`${svc.healthUrl ?? "unknown"}\``,
    `- **Why:** ${reason}`,
    "",
    "**What this means:** the service is UP and answering health checks — this is not an " +
      "outage. Its DB connection pool is failing to release connections when it recycles, so " +
      "each recycle strands sockets that stay ESTABLISHED for the life of the process. Left " +
      "alone this exhausts the shared Supavisor client budget and takes down every service, " +
      "not just this one.",
    "",
    "**Why this alert exists:** for months this failure was recorded ONLY as a `log.warn` — 88 " +
      "abandoned closes and zero clean ones went unnoticed until an unrelated investigation " +
      "happened to grep the daemon log (mt#4515). mt#4549 made the outcome a counter; this " +
      "check is what reads it.",
    "",
    "**Action:** read `dbRecycle` on the service's `/api/health` for the current split, then " +
      "check whether `PostgresPersistenceProvider.close()` is still passing postgres-js a " +
      "`timeout` (`CLOSE_TIMEOUT_SECONDS`). An abandoned close post-mt#4515 means the driver's " +
      "own destroy path failed too, which is a new fault rather than the old one recurring — " +
      "`scripts/verify-close-terminates-wedged-pool.ts` reproduces a wedged pool on demand.",
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
      "WARNING: RAILWAY_TOKEN not set — the deploy-status check cannot run, and the " +
        "digest check cannot run for image-source services. Since mt#3921 those count as " +
        "FAILED checks, not skips: every affected service will be DEGRADED and raise a " +
        "check-failed alert. Only the /health probe carries information in this state."
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

  // mt#3963 — resolution state, gathered ONCE per run rather than per
  // (service, class). `runRef` is named in every close comment so a reader can
  // go straight to the run that observed the recovery (SC1).
  const runId = process.env["GITHUB_RUN_ID"] ?? null;
  const runRef = runId
    ? `monitor run ${runId} (https://github.com/${githubRepo}/actions/runs/${runId})`
    : "a local monitor run (GITHUB_RUN_ID not set)";
  const openMonitorP0s = dryRun ? [] : await listOpenMonitorP0s(githubRepo, githubToken);
  if (!dryRun) {
    // "considered", not "eligible": this count is label-filtered only. Each
    // one still has to pass the monitor-authorship check before it is touched.
    console.log(`Open labeled P0s considered for resolution: ${openMonitorP0s.length}\n`);
  }

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
      // mt#3921 — "SKIP" read as "nothing to check" and meant "I could not
      // look." The word is the bug's user-facing half; say which it is.
      const digestStatus = result.digestLagAlert
        ? "LAG"
        : result.digestLagError
          ? `COULD-NOT-RUN (${result.digestLagError})`
          : "OK";
      console.log(
        `  Digest:        deployed=${result.deployedDigest ?? "?"} registry=${result.registryDigest ?? "?"} — ${digestStatus}`
      );
    }

    // mt#3251 R2: never escalate on a single observation — a healthy
    // build+push+redeploy cycle transiently lags for a few minutes, and
    // this check runs every 10 minutes. Route through the cross-run
    // pending-tracker before deciding to alert. Resolved here, BEFORE
    // scoring, so the scorer itself stays a pure function (mt#3921).
    let digestLagSustained = false;

    if (result.digestLagAlert && result.deployedDigest && result.registryDigest) {
      const sustained = await resolveDigestLagSustained(
        githubRepo,
        githubToken,
        svc.name,
        result.deployedDigest,
        result.registryDigest,
        dryRun
      );
      console.log(`  Digest-lag sustained-check: ${sustained.note}`);
      digestLagSustained = sustained.escalate;
    } else if (svc.image && !result.digestLagError) {
      // Digest check ran cleanly and found no lag this run — if a pending
      // tracker exists from an earlier observation, the transient lag
      // resolved before it persisted past the elapsed-time threshold
      // (DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS, mt#3284). Clean it up
      // rather than leaving a stale "possible lag" issue open forever.
      await closeDigestLagPendingTracker(githubRepo, githubToken, svc.name, dryRun);
    }

    // mt#3921 — a check that could not run alerts here rather than passing
    // silently into a HEALTHY verdict. See monitor-verdict.ts for the rule.
    const score = scoreService(result.summary, digestLagSustained);

    // mt#3963 — retire P0s whose condition this run observed as RECOVERED.
    // Runs for healthy and degraded services alike: a service that is down on
    // its health probe can still have a resolved digest-lag P0 to close, and
    // the classes are independent. Only classes with positive recovery
    // evidence are passed here, so an unrunnable check closes nothing.
    for (const recoveredClass of observedRecoveredClasses(result.summary)) {
      await resolveP0IfRecovered(
        githubRepo,
        githubToken,
        openMonitorP0s,
        svc.name,
        recoveredClass,
        runRef,
        dryRun
      );
    }

    // A Record, not a ternary chain (mt#1495) — same reason as `issueTitle`. The
    // chain this replaces fell through to `formatCheckFailedDetails` for anything
    // unrecognized, so a new class would have been written into the P0 body as
    // "the monitor's checks could not run" — describing the alert as the OPPOSITE
    // of what it is, since check (d) firing means the check ran fine and found a
    // fault. Exhaustive keys make the omission a compile error.
    const ALERT_BODY: Record<AlertClass, (reason: string) => string> = {
      "deploy-failed": () => formatDeployFailedDetails(svc, result),
      "health-down": () => formatHealthDownDetails(svc, result),
      "digest-lag": () => formatDigestLagDetails(svc, result),
      "check-failed": (reason) => formatCheckFailedDetails(svc, result, reason),
      "recovery-degraded": (reason) => formatRecoveryDegradedDetails(svc, reason),
    };

    const alerts = score.alerts.map((alert) => ({
      class: alert.class,
      details: ALERT_BODY[alert.class](alert.reason),
    }));

    if (score.verdict === "HEALTHY") {
      console.log(`  Status: HEALTHY`);
      continue;
    }

    console.log(`  Status: DEGRADED — ${alerts.length} alert(s)`);
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
          // mt#3921 R1: reuse issueTitle so both channels read identically —
          // the raw class name ("check-failed") is not a sentence an operator
          // can act on, and a second mapping would drift from the first.
          const subject = `${issueTitle(svc.name, alert.class)} — GitHub issue ${issueUrl}`;
          await alertViaMcp(mcpAuthToken, svc.name, alert.class, subject, alert.details);
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
