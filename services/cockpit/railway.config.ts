// Synthesizer source for the `cockpit-preview` Railway service (mt#2096).
// Canonical apply path:
//   bun scripts/railway/apply.ts services/cockpit            # dry-run
//   bun scripts/railway/apply.ts services/cockpit --execute  # apply
//
// Resource IDs below are for the `cockpit-preview` Railway project in
// workspace `Eugene Dobry's Projects`. The synthesizer fails fast on
// unknown IDs, so a typo is loud, not silent. If the service is ever
// recreated, update all three values together.
import { defineRailwayConfig, secret } from "../../scripts/railway/lib";

export default defineRailwayConfig({
  projectId: "62db6727-ed10-415e-afc5-7188c9983c81",
  environmentId: "cc3d2bc3-13cc-4061-9633-cd58f48dc3fe",
  serviceId: "83273eef-b451-42af-b3e4-7e1c42b8bb50",
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
