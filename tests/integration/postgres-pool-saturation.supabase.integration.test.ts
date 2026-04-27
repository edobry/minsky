/**
 * Postgres Pool Saturation Integration Tests — Supabase Preview Branch
 *
 * Exercises Minsky's withPgPoolRetry / isPgPoolExhaustionError end-to-end
 * against a real Supabase preview branch backed by Supavisor session-mode
 * pooler. This harness validates that:
 *
 *   - The retry path observes genuine Supavisor XX000 "max clients reached"
 *     error shapes (not synthetic ones from unit tests).
 *   - All four mt#1205 acceptance tests pass against the Supabase backend.
 *
 * Tasks: mt#1205 (umbrella), mt#1364 (this file — child A)
 *
 * Gate: runs ONLY when both env vars are set:
 *   RUN_INTEGRATION_TESTS=1
 *   SUPABASE_INTEGRATION_BRANCH_URL=<postgres connection string>
 *
 * Optional pool-size hint:
 *   SUPABASE_INTEGRATION_BRANCH_POOL_SIZE=<integer>  (default: 15)
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 \
 *   SUPABASE_INTEGRATION_BRANCH_URL="postgresql://postgres.xxx:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
 *   bun test tests/integration/postgres-pool-saturation.supabase.integration.test.ts
 *
 * See docs/persistence-configuration.md § "Saturation integration tests" for
 * branch provisioning instructions and cost information.
 */

import { runSaturationSuite } from "./postgres-pool-saturation.shared";

const BRANCH_URL = process.env.SUPABASE_INTEGRATION_BRANCH_URL;
const POOL_SIZE = Number(process.env.SUPABASE_INTEGRATION_BRANCH_POOL_SIZE) || 15;

// Skip-gate pattern: uses a top-level if/else rather than describe.if(...) because
// runSaturationSuite creates its own describe block internally. Using describe.if()
// here would produce a nested-describe shape that is awkward for child C (mt#1365)
// to reuse. Option (b) from the review: keep the shared helper's internal describe
// and let the wrapper use if/else with a console.log for the skip case.
// mt#1365 implementer: retain this pattern when wiring the docker harness.
if (process.env.RUN_INTEGRATION_TESTS && BRANCH_URL) {
  runSaturationSuite({
    connectionString: BRANCH_URL,
    poolSize: POOL_SIZE,
    label: "supabase-preview",
  });
} else {
  // Emit a single informational message so the runner shows why the file
  // produced zero tests, but does NOT register any test (no false positives).
  const missing: string[] = [];
  if (!process.env.RUN_INTEGRATION_TESTS) missing.push("RUN_INTEGRATION_TESTS=1");
  if (!BRANCH_URL) missing.push("SUPABASE_INTEGRATION_BRANCH_URL=<connection-string>");
  console.log(`[saturation/supabase] integration tests skipped — set ${missing.join(", ")} to run`);
}
