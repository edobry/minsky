/**
 * Deployment-target declaration for the `minsky-ops` service.
 *
 * Provisioned mt#2132 (2026-07-29). Runs the SAME GHCR image as minsky-mcp
 * (`ghcr.io/edobry/minsky:latest`), with a start-command override so it
 * boots the ops background-loop / health-endpoint process instead of the
 * MCP server.
 *
 * ## Relationship to minsky-mcp
 *
 * Same image, different start command:
 *   minsky-mcp:  `bun run --preload reflect-metadata dist/minsky.js mcp start --http --host 0.0.0.0 --port $PORT --require-auth`
 *   minsky-ops:  `bun run --preload reflect-metadata dist/minsky.js ops start`
 *
 * The `--preload reflect-metadata` wrapper mirrors the root Dockerfile's CMD
 * (see `Dockerfile`'s comment on Bun 1.2.23's bundler reordering
 * `import "reflect-metadata"` in the flattened bundle) — `ops start` boots
 * the same tsyringe-based domain container as `mcp start`, so it needs the
 * same preload to avoid the polyfill-ordering crash.
 *
 * ## Start-command override mechanism (mt#2132)
 *
 * The Pulumi `railway.Service` resource (terraform-community-providers/railway
 * bridge, see `infra/index.ts`'s `minskyOpsService` comment) has no
 * `startCommand`/`deploy.*` field, so the override is NOT expressed in
 * `infra/index.ts`. It was set out-of-band via:
 *
 *   railway environment edit --json <<< '{"services":{"<serviceId>":{"deploy":{"startCommand":"bun run --preload reflect-metadata dist/minsky.js ops start"}}}}'
 *
 * Verified via read-back: `railway environment config --json | jq '.services["<serviceId>"].deploy'`.
 * This is a one-time operator action, same class as the reviewer service's
 * `deploy.healthcheckPath` gap documented in `infra/index.ts`.
 *
 * ## Environment variables
 *
 * Declared in `infra/index.ts`'s `minskyOpsService` block (Pulumi-managed).
 * Inherits all minsky-mcp variables (same domain-container bootstrap) except
 * `MINSKY_MCP_MAX_SESSIONS` (MCP-HTTP-transport-only, not applicable), plus:
 *   ADOPTION_SWEEPER_ENABLED       — "true" (set; sweeper active)
 *   ADOPTION_SWEEPER_EXECUTE       — NOT set (dry-run default, mt#3328)
 *   ADOPTION_SWEEPER_INTERVAL_MS   — interval in ms (default: 86400000 = 24h)
 *   ADOPTION_SWEEPER_LOOKBACK_DAYS — days to look back (default: 14)
 *
 * @see mt#2101 — implementation task (ops service code)
 * @see mt#2097 — operational topology epic
 * @see mt#2132 — this provisioning task
 * @see mt#3328 — adoption-sweeper container-blindness fix (gates enabling the sweeper)
 */

import { defineDeployment } from "@minsky/shared/deployment-config";

export default defineDeployment({
  platform: "railway",
  healthUrl: "https://minsky-ops-production.up.railway.app/health",
  railway: {
    projectId: "0e054318-7e19-4489-8e1e-de787965161d", // same project as minsky-mcp
    environmentId: "0289b171-1514-4540-ac93-19b30da3e2c0", // same environment (production)
    serviceId: "f6e3f285-8075-4845-934b-8e9bed15ab12",
    source: {
      image: "ghcr.io/edobry/minsky:latest",
    },
  },
});
