#!/usr/bin/env bun
/**
 * Live verification for mt#3991: does `resolveExistingTaskIds` actually run,
 * and does its drizzle `in ${array}` form produce a valid parameter list?
 *
 * PR #2876 R1 raised the IN-clause as BLOCKING. The sibling
 * `duplicate-signature-scan.ts` carries a comment asserting the opposite from a
 * live run. Both are prose; this settles it by executing the query.
 *
 * Discriminating input: two ids that EXIST and one that never did (mt#3891, the
 * real positive from the calibration window). A malformed IN-clause throws or
 * returns nothing; a working one returns exactly the two that exist. Those
 * outcomes are distinguishable, which is the point — a probe that cannot fail
 * carries no information.
 *
 * Exits 0 on pass, 1 on fail, and 0 with a SKIP when no database is reachable.
 */
import { resolveExistingTaskIds } from "../.minsky/hooks/constructed-identifier-batch-detector";

const EXISTING = ["mt#2566", "mt#1097"];
const ABSENT = "mt#3891";

async function main(): Promise<void> {
  const result = await resolveExistingTaskIds([...EXISTING, ABSENT]);

  if (result === null) {
    // Indistinguishable here from a genuine failure, which is why this exits 0
    // rather than claiming a pass: no database, no evidence either way.
    console.log("SKIP: lookup returned null (no reachable database from this context).");
    console.log("      This is the fail-toward-firing path — it is not a verification.");
    process.exit(0);
  }

  const found = [...result].sort();
  const missingExpected = EXISTING.filter((id) => !result.has(id));
  const falselyPresent = result.has(ABSENT);

  console.log(`queried:  ${[...EXISTING, ABSENT].join(", ")}`);
  console.log(`returned: ${found.length > 0 ? found.join(", ") : "(empty)"}`);

  if (missingExpected.length > 0) {
    console.error(
      `FAIL: expected these to resolve but they did not: ${missingExpected.join(", ")}`
    );
    console.error("      An empty or partial result is what a malformed IN-clause looks like.");
    process.exit(1);
  }
  if (falselyPresent) {
    console.error(`FAIL: ${ABSENT} resolved, but no such task exists.`);
    process.exit(1);
  }

  console.log(`PASS: both existing ids resolved; ${ABSENT} did not.`);
  console.log("      The IN-clause expands correctly and the discriminator works.");
  process.exit(0);
}

await main();
