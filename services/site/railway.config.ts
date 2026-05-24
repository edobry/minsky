// Synthesizer source for the marketing-site Railway service.
//
// Canonical apply path:
//   bun scripts/railway/apply.ts services/site            # dry-run
//   bun scripts/railway/apply.ts services/site --execute  # apply
//
// Hardcoded resource identifiers below are intentional: they are the public
// Railway resource IDs for the `minsky-site` project + service in workspace
// `Eugene Dobry's Projects`. The synthesizer fails fast if any of these
// are wrong (the GraphQL `variables` query rejects unknown IDs), so a typo
// is loud, not silent. If the service is ever recreated, update all three
// values together.
//
// Project history: the `minsky-site` project predates this monorepo absorb
// (it ran the prior Hono+static scaffold from ~/Projects/minsky-site). The
// project also contains three leftover `Postgres*` services left over from
// that scaffold's database backend; the new Astro static site needs no DB.
// Cleanup of the leftover services is a principal-authorized followup
// (out of scope for mt#1934).
//
// Secret-class values resolve via `secret("KEY")` from
// `~/.config/minsky/railway-secrets.json` (or `process.env.KEY`). The site
// itself currently needs no secrets — it's a static Astro build with no
// upstream API calls.

import { defineRailwayConfig } from "../../scripts/railway/lib";

export default defineRailwayConfig({
  projectId: "825920d3-fb22-4163-a50d-0e04fc724774",
  environmentId: "bd90461e-dacf-487c-8594-b50849ade1f0",
  serviceId: "bb4d7cb4-e929-4ab6-83e2-d19cd34f6805",
  variables: {
    NODE_ENV: "production",
    SITE_URL: "https://minsky.dev",
  },
});
