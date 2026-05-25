/**
 * Deployment-target declaration for the `minsky-ops` service.
 *
 * The ops service runs `bun dist/minsky.js ops start --port 8081` using the
 * same Docker image as minsky-mcp. No dedicated serviceId yet — this file
 * is a placeholder that establishes the deployment topology declaration
 * for when the Railway service is provisioned.
 *
 * ## Relationship to minsky-mcp
 *
 * Same image, different start command:
 *   minsky-mcp:  `bun dist/minsky.js mcp start --http --port 8080`
 *   minsky-ops:  `bun dist/minsky.js ops start --port 8081`
 *
 * ## Environment variables
 *
 * Inherits all minsky-mcp variables plus:
 *   ADOPTION_SWEEPER_ENABLED       — "true" to activate (default: false)
 *   ADOPTION_SWEEPER_INTERVAL_MS   — interval in ms (default: 86400000 = 24h)
 *   ADOPTION_SWEEPER_LOOKBACK_DAYS — days to look back (default: 14)
 *
 * @see mt#2101 — implementation task
 * @see mt#2097 — operational topology epic
 */

import { defineDeployment } from "@minsky/shared/deployment-config";

// NOTE: No railway.config.ts yet — the Railway service hasn't been provisioned.
// When it is, add railway.config.ts alongside this file with the project/service
// IDs, then import and use them here (following the minsky-mcp pattern).
//
// For now we export a skeleton so the workspace-COPY pre-commit guard and any
// deployment tooling that walks services/* can discover this service declaration.

export default defineDeployment({
  platform: "railway",
  railway: {
    // Placeholder IDs — replace with real values from Railway when provisioned.
    projectId: "0e054318-7e19-4489-8e1e-de787965161d", // same project as minsky-mcp
    environmentId: "0289b171-1514-4540-ac93-19b30da3e2c0", // same environment
    serviceId: "", // TODO: provision the Railway service and fill in this ID
    source: {
      rootDirectory: "/",
    },
    build: {
      builder: "RAILPACK",
    },
  },
});
