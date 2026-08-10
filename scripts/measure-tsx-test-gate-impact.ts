#!/usr/bin/env bun
/**
 * mt#3868 SC2 — blast-radius measurement for widening `isTestFile` to `.tsx`.
 *
 * The execution-evidence merge gate (mt#1459) BLOCKS a PR that adds a new test
 * file without an `Execution evidence:` block in its body. Its test-file
 * predicate matches `.ts` only, so no `.test.tsx` has ever reached it — which
 * means every cockpit-web test file is invisible to a blocking gate.
 *
 * Widening the predicate therefore does not just fix a blind spot; it EXPANDS
 * what a blocking gate denies. This script measures by how much, against real
 * merged history, BEFORE the widening ships — so the enforcement posture is
 * chosen on evidence rather than on a guess about how well the convention is
 * already followed.
 *
 * ## What "newly blocked" means here
 *
 * A PR counts only when ALL of these hold:
 *   1. Under the CURRENT predicate it introduces no new test file (so the gate
 *      does not fire today), AND
 *   2. under the WIDENED predicate it does (so the gate would fire), AND
 *   3. its body carries no `Execution evidence:` block, AND
 *   4. its title carries no `[unverified-tests]` bypass prefix.
 *
 * Conditions 3 and 4 are what make this a count of PRs that would have been
 * DENIED rather than merely a count of PRs that add a `.tsx` test. Reporting
 * the latter as the former would overstate the impact by however well the
 * convention is already followed — which is precisely the unknown this exists
 * to settle.
 *
 * ## Why it replays the real function
 *
 * Both arms call the SHIPPED `findNewTestFiles`, differing only in the injected
 * predicate (the seam added by mt#3868 for this purpose). Its renamed/copied
 * and `previous_filename` handling is subtle, and a re-implementation here
 * would be a measurement of the copy rather than of the gate.
 *
 * USAGE
 *   GITHUB_TOKEN=$(gh auth token) bun scripts/measure-tsx-test-gate-impact.ts
 *   GITHUB_TOKEN=$(gh auth token) bun scripts/measure-tsx-test-gate-impact.ts --days 90 --limit 600
 *
 * ENV
 *   OCTOKIT_AUTH   Preferred — dedicated token (rate-limit isolation).
 *   GITHUB_TOKEN   Fallback — user PAT (e.g. via `gh auth token`).
 *
 * EXIT CODES
 *   0  Measurement completed; results printed as JSON and a human summary.
 *   2  Skipped — no token available.
 *
 * Writes `scripts/tsx-test-gate-impact-results.json` alongside stdout.
 */

import { writeFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import {
  findNewTestFiles,
  hasExecutionEvidence,
  hasBypassPrefix,
  type PrFile,
} from "../.minsky/hooks/require-execution-evidence-before-merge";
const OWNER = "edobry";
const REPO = "minsky";
const RESULTS_PATH = "scripts/tsx-test-gate-impact-results.json";

/**
 * BOTH predicates are pinned here rather than imported, and that is load-bearing.
 *
 * An earlier draft imported the shared `isTestFile` for the "before" arm. That
 * makes the script self-invalidating the moment the widening lands: both arms
 * become the same function, `newUnderCurrent` is non-empty exactly when
 * `newUnderWidened` is, the "newly in scope" filter excludes everything, and the
 * script cheerfully reports ZERO impact. It did precisely that during mt#3868's
 * own implementation — a 599-PR run reported 0 newly-in-scope where a 220-PR run
 * minutes earlier had found 4, which is impossible for a superset and is the only
 * reason the contamination was noticed.
 *
 * A measurement whose baseline drifts to match the change is not a measurement.
 * Pinning both makes this a stable historical replay: re-running it next year
 * against the same window must still produce the same answer.
 */
const isTestFileBeforeWidening = (filename: string): boolean =>
  /\.(test|integration\.test|spec)\.ts$/.test(filename);

const isTestFileWidened = (filename: string): boolean =>
  /\.(test|integration\.test|spec)\.tsx?$/.test(filename);

function parseIntArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const raw = process.argv[i + 1];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid value for ${flag}: ${String(raw)}`);
    process.exit(1);
  }
  return n;
}

const days = parseIntArg("--days", 60);
const limit = parseIntArg("--limit", 500);

const token = process.env.OCTOKIT_AUTH || process.env.GITHUB_TOKEN;
if (!token) {
  console.log(
    "SKIP: Neither OCTOKIT_AUTH nor GITHUB_TOKEN set.\n" +
      "HINT: GITHUB_TOKEN=$(gh auth token) bun scripts/measure-tsx-test-gate-impact.ts"
  );
  process.exit(2);
}

const octokit = new Octokit({ auth: token });
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

interface Verdict {
  number: number;
  title: string;
  mergedAt: string;
  newUnderCurrent: string[];
  newUnderWidened: string[];
  hasEvidence: boolean;
  hasBypass: boolean;
  wouldBeNewlyBlocked: boolean;
}

console.log(`Scanning merged PRs to main from the last ${days} days (cap ${limit})...`);

const merged: Array<{ number: number; title: string; merged_at: string }> = [];
let scanned = 0;
let hitCap = false;
let reachedCutoff = false;

for await (const page of octokit.paginate.iterator(octokit.rest.pulls.list, {
  owner: OWNER,
  repo: REPO,
  state: "closed",
  base: "main",
  sort: "updated",
  direction: "desc",
  per_page: 100,
})) {
  for (const pr of page.data) {
    scanned += 1;
    if (scanned > limit) {
      hitCap = true;
      break;
    }
    if (!pr.merged_at) continue;
    if (Date.parse(pr.merged_at) < cutoff) {
      reachedCutoff = true;
      continue;
    }
    merged.push({ number: pr.number, title: pr.title, merged_at: pr.merged_at });
  }
  if (hitCap) break;
  // `sort: updated` is not merge order, so a single old page is not proof the
  // window is exhausted. Keep paging until the cap; the cap is what bounds us,
  // and it is reported.
}

if (hitCap) {
  console.warn(
    `NOTE: stopped at the --limit cap of ${limit} scanned PRs. The count below is a ` +
      `LOWER BOUND on the window — re-run with a higher --limit for full coverage.`
  );
}
if (!reachedCutoff && !hitCap) {
  console.warn(
    `NOTE: never saw a PR older than the ${days}-day cutoff, so the repo's closed-PR ` +
      `history may be shorter than the window. Treat the window as "all history".`
  );
}

console.log(`${merged.length} merged PRs in window; fetching files + bodies...`);

const verdicts: Verdict[] = [];
for (const pr of merged) {
  const files: PrFile[] = (
    await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: OWNER,
      repo: REPO,
      pull_number: pr.number,
      per_page: 100,
    })
  ).map((f) => ({
    filename: f.filename,
    status: f.status as PrFile["status"],
    previous_filename: f.previous_filename ?? null,
  }));

  const newUnderCurrent = findNewTestFiles(files, isTestFileBeforeWidening);
  const newUnderWidened = findNewTestFiles(files, isTestFileWidened);

  // Only PRs the widening newly brings into scope can be newly blocked.
  if (newUnderCurrent.length > 0 || newUnderWidened.length === 0) continue;

  const detail = await octokit.rest.pulls.get({
    owner: OWNER,
    repo: REPO,
    pull_number: pr.number,
  });
  const body = detail.data.body ?? "";
  const hasEvidence = hasExecutionEvidence(body);
  const hasBypass = hasBypassPrefix(pr.title);

  verdicts.push({
    number: pr.number,
    title: pr.title,
    mergedAt: pr.merged_at,
    newUnderCurrent,
    newUnderWidened,
    hasEvidence,
    hasBypass,
    wouldBeNewlyBlocked: !hasEvidence && !hasBypass,
  });
}

const newlyInScope = verdicts.length;
const newlyBlocked = verdicts.filter((v) => v.wouldBeNewlyBlocked);

const results = {
  measuredAt: new Date().toISOString(),
  windowDays: days,
  scanLimit: limit,
  hitCap,
  mergedPrsInWindow: merged.length,
  newlyInScope,
  newlyBlockedCount: newlyBlocked.length,
  newlyBlocked: newlyBlocked.map((v) => ({
    number: v.number,
    title: v.title,
    mergedAt: v.mergedAt,
    testFiles: v.newUnderWidened,
  })),
  inScopeButAlreadyCompliant: verdicts
    .filter((v) => !v.wouldBeNewlyBlocked)
    .map((v) => ({ number: v.number, hasEvidence: v.hasEvidence, hasBypass: v.hasBypass })),
};

writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);

console.log("");
console.log(`Merged PRs scanned in window:     ${merged.length}`);
console.log(`Newly in scope (add a .tsx test): ${newlyInScope}`);
console.log(`WOULD HAVE BEEN BLOCKED:          ${newlyBlocked.length}`);
console.log("");
for (const v of newlyBlocked) {
  console.log(`  #${v.number} ${v.title}`);
  for (const f of v.newUnderWidened) console.log(`      + ${f}`);
}
console.log("");
console.log(`Results written to ${RESULTS_PATH}`);
