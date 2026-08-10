#!/usr/bin/env bun
/**
 * mt#3907 AT3 — the discriminating test.
 *
 * Proves the post-merge deploy gate can now FAIL. Runs the SAME wait twice
 * against the live minsky-mcp service, changing only `notBefore`:
 *
 *   unbounded → returns the stale record as SUCCESS  (the old, broken behavior
 *               that let a 4.5-day outage pass every post-merge check)
 *   bounded   → raises NoDeploymentSinceError        (the fix)
 *
 * Read-only: `waitForLatestDeployment` only queries. Requires a Railway
 * credential; skips cleanly without one.
 */
// The deployment adapter is tsyringe-@injectable; the polyfill must load
// before any decorated class is imported.
import "reflect-metadata";
import { resolveDeploymentConfig, resolveAdapter } from "../packages/domain/src/deployment/index";
import { NoDeploymentSinceError } from "../packages/domain/src/deployment/types";

const SERVICE = "minsky-mcp";

const { config } = await resolveDeploymentConfig(SERVICE);
const adapter = resolveAdapter(config);

let failures = 0;

// --- Case 1: unbounded (legacy contract) ---------------------------------
console.log("=== unbounded wait (pre-mt#3890 contract) ===");
try {
  const record = await adapter.waitForLatestDeployment({ timeoutSeconds: 30 });
  console.log(`  returned ${record.status} created ${record.createdAt}`);
  const ageDays = (Date.now() - Date.parse(record.createdAt)) / 86_400_000;
  console.log(`  → age: ${ageDays.toFixed(1)} days`);
  if (record.status === "SUCCESS" && ageDays > 1) {
    console.log("  ✓ reproduces the defect: a stale record reported as SUCCESS");
  }
} catch (e) {
  console.log(`  unexpected throw: ${(e as Error).message}`);
  failures++;
}

// --- Case 2: bounded to now (what a post-merge gate does) -----------------
const notBefore = new Date().toISOString();
console.log(`\n=== bounded wait (notBefore=${notBefore}) ===`);
try {
  const record = await adapter.waitForLatestDeployment({
    timeoutSeconds: 5,
    pollIntervalSeconds: 1,
    notBefore,
  });
  console.log(`  ✗ FAIL — returned ${record.status} from ${record.createdAt}; expected a throw`);
  failures++;
} catch (e) {
  if (e instanceof NoDeploymentSinceError) {
    console.log(`  ✓ NoDeploymentSinceError raised, as required`);
    console.log(`    newest seen: ${e.newestRecord?.status} @ ${e.newestRecord?.createdAt}`);
    console.log(`    message: ${e.message}`);
  } else {
    console.log(`  ✗ FAIL — wrong error type: ${(e as Error).name}: ${(e as Error).message}`);
    failures++;
  }
}

console.log(`\n=== ${failures === 0 ? "PASS" : `FAIL (${failures})`} ===`);
process.exit(failures === 0 ? 0 : 1);
