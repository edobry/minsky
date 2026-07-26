/**
 * Service-identity assertion for health probes (mt#3148).
 *
 * ## Why a bare 200 is not a health check
 *
 * Every Minsky service is built from the same monorepo, so a misconfigured
 * build can put a DIFFERENT application on a service's host — and that
 * application will happily answer `GET /health` with `200 {"status":"ok"}`.
 * mt#3142 is the proof, not a hypothetical: the Minsky MCP server was deployed
 * onto the reviewer's Railway host and served `/health` 200 for roughly an hour
 * while every reviewer route 404'd. Railway's healthcheck reads status only, so
 * the one signal wired to alerting was the one signal that could not detect the
 * fault.
 *
 * The generalizable rule, from mt#3148's spec: **a verification probe must be
 * able to fail.** Before a probe's output is treated as evidence, establish
 * that the broken state would produce a *different* output. A probe whose
 * output space does not separate the states you care about carries zero
 * information — and is worse than no probe, because a green check nobody
 * investigates manufactures confidence.
 *
 * ## The contract
 *
 * Every Minsky service emits `service: "<canonical-name>"` in its `/health`
 * body. Probes assert that value, not merely the status code.
 *
 * @see contract/cockpit-health-shape.json — the cockpit's declared shape
 * @see mt#3142 — the originating incident
 */

/**
 * Canonical `service` values. One per deployed Minsky application that serves
 * a health endpoint.
 *
 * `minsky-ops` is deliberately absent: `services/minsky-ops/` contains only a
 * `deploy.config.ts` and no application source, so it has no health endpoint to
 * identify (verified 2026-07-26).
 */
export const SERVICE_IDENTITIES = {
  cockpit: "minsky-cockpit",
  mcp: "minsky-mcp",
  reviewer: "minsky-reviewer",
  site: "minsky-site",
} as const;

export type ServiceIdentity = (typeof SERVICE_IDENTITIES)[keyof typeof SERVICE_IDENTITIES];

/**
 * Map a `services/<dir>` name to its canonical identity.
 *
 * The directory names and the identity values are NOT the same string for every
 * service (`services/cockpit` emits `minsky-cockpit`), so consumers that
 * discover services by walking `services/*` — notably
 * `scripts/post-deploy-health-monitor.ts` — need this translation rather than
 * assuming the directory name is the identity.
 *
 * Returns null for a directory with no identifiable health endpoint (today:
 * `minsky-ops`, which has only a `deploy.config.ts`). A null means "do not
 * assert identity for this service", never "this service failed".
 */
export function identityForServiceDir(dir: string): ServiceIdentity | null {
  switch (dir) {
    case "cockpit":
      return SERVICE_IDENTITIES.cockpit;
    case "minsky-mcp":
      return SERVICE_IDENTITIES.mcp;
    case "reviewer":
      return SERVICE_IDENTITIES.reviewer;
    case "site":
      return SERVICE_IDENTITIES.site;
    default:
      return null;
  }
}

/** Outcome of an identity assertion. Never throws — callers decide severity. */
export type HealthIdentityResult =
  | { ok: true; service: ServiceIdentity }
  | { ok: false; reason: "not-json"; detail: string }
  | { ok: false; reason: "missing-identity"; detail: string }
  | { ok: false; reason: "wrong-service"; expected: ServiceIdentity; actual: string };

/**
 * Assert that a `/health` body belongs to `expected`.
 *
 * Distinguishes three failure modes deliberately, because they mean different
 * things operationally:
 *
 *  - `not-json` — something is answering that is not a Minsky health endpoint
 *    at all (a proxy error page, an HTML 200).
 *  - `missing-identity` — a Minsky-shaped response with no `service` key. Either
 *    a service that predates this contract, or (the dangerous case) a different
 *    application whose health body happens to be JSON.
 *  - `wrong-service` — the decisive one: a Minsky service answered, and it is
 *    the WRONG one. This is the mt#3142 signature.
 *
 * Collapsing these into a boolean would lose exactly the information that makes
 * the probe actionable.
 */
export function assertServiceIdentity(
  body: unknown,
  expected: ServiceIdentity
): HealthIdentityResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "not-json", detail: `expected an object, got ${typeof body}` };
  }

  const service = (body as Record<string, unknown>)["service"];
  if (typeof service !== "string" || service.length === 0) {
    return {
      ok: false,
      reason: "missing-identity",
      detail: "health body has no `service` field",
    };
  }

  if (service !== expected) {
    return { ok: false, reason: "wrong-service", expected, actual: service };
  }

  return { ok: true, service: expected };
}

/** Human-readable one-liner for logs and smoke-script output. */
export function describeHealthIdentityResult(result: HealthIdentityResult): string {
  if (result.ok) return `identity OK: ${result.service}`;
  switch (result.reason) {
    case "not-json":
      return `identity FAILED: response is not a JSON object (${result.detail})`;
    case "missing-identity":
      return `identity FAILED: ${result.detail}`;
    case "wrong-service":
      return (
        `identity FAILED: expected "${result.expected}" but the host is serving ` +
        `"${result.actual}" — a different application is deployed here`
      );
  }
}
