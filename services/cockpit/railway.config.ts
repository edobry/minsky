// Synthesizer source for the `cockpit-preview` Railway service (mt#2096).
// Canonical apply path:
//   bun scripts/railway/apply.ts services/cockpit            # dry-run
//   bun scripts/railway/apply.ts services/cockpit --execute  # apply
//
// PLACEHOLDER IDs: projectId / environmentId / serviceId below are
// placeholders. Replace with real values after creating the Railway project
// and service. The synthesizer fails fast on unknown IDs, so incorrect
// values are loud.
import { defineRailwayConfig, secret } from "../../scripts/railway/lib";

export default defineRailwayConfig({
  // TODO(mt#2096): replace with real Railway resource IDs after project creation
  projectId: "PLACEHOLDER_PROJECT_ID",
  environmentId: "PLACEHOLDER_ENVIRONMENT_ID",
  serviceId: "PLACEHOLDER_SERVICE_ID",
  variables: {
    // Read-only Supabase connection string — uses a dedicated DB role with
    // SELECT-only permissions. Defense-in-depth data layer paired with the
    // API-layer preview-mode guard in src/cockpit/server.ts.
    MINSKY_PERSISTENCE_BACKEND: "postgres",
    MINSKY_PERSISTENCE_POSTGRES_URL: secret("MINSKY_COCKPIT_PREVIEW_POSTGRES_URL"),

    // Preview-mode flag — triggers the mutation-blocking middleware in
    // src/cockpit/server.ts. Set to "true" for all preview deployments.
    MINSKY_COCKPIT_PREVIEW: "true",
  },
});
