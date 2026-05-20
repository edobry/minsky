// Synthesizer source for the marketing-site Railway service.
//
// Canonical apply path:
//   bun scripts/railway/apply.ts services/site            # dry-run
//   bun scripts/railway/apply.ts services/site --execute  # apply
//
// IDs below are PLACEHOLDERS — the marketing-site Railway service has not
// yet been provisioned. Provisioning is a principal-level action (creates a
// new Railway resource billable to the workspace and binds the public
// domain). Once the service exists, replace the three IDs with the actual
// Railway resource identifiers — the synthesizer fails fast at apply time
// if they're wrong, so a typo is loud, not silent.
//
// Provisioning steps (one-time, principal-authorized):
//   1. `railway init -n minsky-site -w "Eugene Dobry's Projects"` to create
//      the project. Capture projectId from the response.
//   2. `railway up --service minsky-site` to create the default service and
//      first deployment. Capture serviceId.
//   3. `railway environment list` to capture environmentId (production).
//   4. Update the three placeholder strings below and re-run `apply`.
//   5. Set the custom domain (`minsky.dev`) in the Railway dashboard.
//
// Secret-class values resolve via `secret("KEY")` from
// `~/.config/minsky/railway-secrets.json` (or `process.env.KEY`). The
// `secret()` argument MUST match a key in the secrets file — see
// `scripts/railway/lib.ts:resolveSecret`. The site itself currently needs
// no secrets — it's a static Astro build with no upstream API calls.

import { defineRailwayConfig } from "../../scripts/railway/lib";

export default defineRailwayConfig({
  projectId: "TBD-PROVISION-RAILWAY-SERVICE",
  environmentId: "TBD-PROVISION-RAILWAY-SERVICE",
  serviceId: "TBD-PROVISION-RAILWAY-SERVICE",
  variables: {
    NODE_ENV: "production",
    SITE_URL: "https://minsky.dev",
  },
});
