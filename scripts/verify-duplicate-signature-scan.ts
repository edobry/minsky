#!/usr/bin/env bun
// Live verification for the duplicate-signature scan (mt#3722).
//
// Replays the ORIGINATING INCIDENT against the real task corpus: feed the scan
// mt#3719's actual title and spec text, and assert it surfaces mt#3575 — the
// task mt#3719 duplicated, which mt#3719's own duplicate-check record never
// named and which the embedding probe ranked at 1.105, below unrelated tasks.
//
// This is the check the unit tests cannot make. They prove the token rules
// extract `GET /api/sweeps` and that mt#3575 is absent from the record; only a
// live run proves the SQL finds it in the corpus as it actually stands.
//
// Skips cleanly (exit 0) when no database is reachable, so running it
// unattended is safe — CI has no corpus and is expected to skip.
//
// Usage: bun scripts/verify-duplicate-signature-scan.ts

import "reflect-metadata";
import { scanForSignatureMatches } from "../.minsky/hooks/duplicate-signature-scan";

/** The subject line of the task that was filed as a duplicate (mt#3719). */
const TITLE =
  "GET /api/sweeps transcriptCoverage test asserts null but reaches the real database on any machine with one";

/**
 * An excerpt of mt#3719's spec carrying its distinctive tokens plus the
 * duplicate-check record it actually shipped with — five candidates, all
 * reconciled confirm-orthogonal, and mt#3575 absent.
 */
const SPEC = `## Summary

\`src/cockpit/routes/sweeps.test.ts\` asserts that the route's \`transcriptCoverage\`
block is null. The route calls \`getTranscriptCoverage()\`
(\`src/cockpit/transcript-coverage.ts\`), which resolves persistence internally.

(fail) GET /api/sweeps > carries a transcriptCoverage block

## Context

Duplicate check: mt#3609 (confirm-orthogonal), mt#3538 (confirm-orthogonal),
mt#1024 (confirm-orthogonal), mt#3501 (confirm-orthogonal), mt#3237
(confirm-orthogonal). No task covers this route or this assertion.
`;

/** The task mt#3719 actually duplicated. Finding it is the whole point. */
const EXPECTED_TASK_ID = "mt#3575";

async function main(): Promise<number> {
  const started = Date.now();
  const result = await scanForSignatureMatches(TITLE, SPEC);
  const elapsedMs = Date.now() - started;

  if (result.failed) {
    // Distinguish "no corpus here" (a legitimate skip) from a real failure.
    const skippable =
      result.failed.includes("persistence provider unavailable") ||
      result.failed.includes("no database connection") ||
      result.failed.includes("domain bootstrap failed") ||
      result.failed.includes("not SQL-capable");
    if (skippable) {
      console.log(`SKIP: no reachable task corpus (${result.failed})`);
      return 0;
    }
    console.error(`FAIL: scan errored: ${result.failed}`);
    return 1;
  }

  console.log(`Scan completed in ${elapsedMs}ms`);
  console.log(`Tokens tried: ${result.tokensTried.map((t) => `${t.rule}:${t.text}`).join(", ")}`);
  if (result.tokensDroppedAsUbiquitous.length > 0) {
    console.log(`Dropped as ubiquitous: ${result.tokensDroppedAsUbiquitous.join(", ")}`);
  }
  console.log(`Matches: ${result.matches.length}`);
  for (const m of result.matches) {
    console.log(`  ${m.taskId} (${m.status}) via "${m.token.text}" [${m.token.rule}]`);
    if (m.excerpt) console.log(`    ${m.excerpt}`);
  }

  const found = result.matches.find((m) => m.taskId === EXPECTED_TASK_ID);
  if (!found) {
    console.error(
      `FAIL: ${EXPECTED_TASK_ID} was NOT surfaced. This is the incident the scan exists to catch;\n` +
        `      if mt#3575 has since gone terminal the scan correctly excludes it — check its status\n` +
        `      before treating this as a regression.`
    );
    return 1;
  }

  console.log(
    `\nPASS: surfaced ${EXPECTED_TASK_ID} via "${found.token.text}" — the task mt#3719's own\n` +
      `duplicate-check record never named, and that the embedding probe ranked at 1.105.`
  );

  // The scan must also stay inside its budget on the real corpus, not just in
  // principle: a correct result that takes 5s is a timeout in production.
  if (elapsedMs > 5000) {
    console.error(`FAIL: scan took ${elapsedMs}ms, at or past its own SCAN_TIMEOUT_MS budget`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`FAIL: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
