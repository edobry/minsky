#!/usr/bin/env bun
/**
 * mt#4544 SC6 / AT4 — measure the false-positive rate before proposing any
 * posture change.
 *
 * Replays the check over RECENTLY MERGED PRs: for each PR whose title binds a
 * task, take that task's spec, strict-extract its in-scope paths, and compare
 * them against the PR's ACTUAL changed-file list from the forge.
 *
 * Why this replay uses the forge's file list rather than the transcript's edit
 * calls, when the shipped guard uses the transcript: the guard runs at
 * `session_pr_create`, where no PR exists yet and the session's edits are the
 * only available proxy for the diff. A replay has the merged PR in hand, so it
 * can use the real thing — which makes this measurement a STRICTLY HARDER test
 * of the enumeration than the guard faces, since the forge list includes edits
 * the transcript may have missed (a rebase, a generated file re-staged by
 * pre-commit). A path this reports as untouched was untouched in the merged
 * diff, full stop.
 *
 * Usage:
 *   bun scripts/replay-spec-scope-execution.ts [--limit N] [--json <path>]
 *
 * Exits 0 on a completed replay (this is a measurement, not a gate); non-zero
 * when it could not run — no `gh`, no `minsky`, or zero PRs resolved.
 */

import { writeFileSync } from "node:fs";
import { extractInScopeFiles } from "../.minsky/hooks/parallel-work-guard";
import { untouchedEnumeratedPaths } from "../.minsky/hooks/spec-scope-execution-check";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? "60") : 60;
const jsonIdx = args.indexOf("--json");
const JSON_OUT = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;

function sh(cmd: string[], timeoutMs = 30_000): string | null {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    if (r.exitCode !== 0) return null;
    return new TextDecoder().decode(r.stdout);
  } catch {
    // intentional-swallow: a missing binary or a timeout is reported by the
    // caller as an unusable probe, not as an empty result (mem#704).
    return null;
  }
}

/** `fix(mt#4109): ...` / `feat(mt#4544): ...` → `mt#4109`. */
export function taskIdFromTitle(title: string): string | null {
  const m = title.match(/^[a-z]+\(([a-z]{2}#\d+)\)/i);
  return m?.[1] ?? null;
}

interface Row {
  pr: number;
  taskId: string;
  enumerated: string[];
  changed: number;
  untouched: { path: string; line: string | null }[];
  /** Untouched entries the spec's own wording exempted (mt#4582). */
  qualified: number;
}

/*
 * The comparison is IMPORTED from the guard, not reimplemented here (mt#4591).
 *
 * This script previously carried its own `normalize` + `covered` pair, a copy
 * of the guard's. That is a measurement instrument that does not exercise the
 * thing it measures: mt#4591 fixed `pathIsCovered` to resolve `path.ts:83` and
 * directory globs, and re-running this replay would have reported ZERO change —
 * a null result attributable to the duplicate, not to the fix. Same
 * class-not-instance shape the guard itself exists to catch (mem#1060).
 */

/*
 * The ENTRY-quoting helper is imported too (mt#4582), for the same reason the
 * comparison is. This script carried a `lineFor` copy of the guard's
 * `enumerationLineFor` — the THIRD copy of that logic — and PR #3340 R1 had
 * already had to fix the same defect in both places independently. mt#4582
 * taught the guard's version to join a bullet's continuation lines; a local
 * copy would have kept quoting truncated first lines, and the replay's quote IS
 * the hand-classification evidence.
 */

/**
 * `owner/repo`, derived from the git remote rather than hard-coded (PR #3340
 * R1). Fails loudly instead of silently measuring the wrong repository.
 */
function repoSlug(): string {
  const out = sh(["git", "remote", "get-url", "origin"], 10_000);
  const m = out?.match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?\s*$/);
  if (!m?.[1]) {
    console.error("FAIL: could not derive owner/repo from `git remote get-url origin`.");
    process.exit(1);
  }
  return m[1];
}

/** GitHub caps `per_page` at 100; 10 pages = 1,000 files, past any real PR here. */
const MAX_FILE_PAGES = 10;

const REPO = repoSlug();

const listRaw = sh([
  "gh",
  "api",
  `repos/${REPO}/pulls?state=closed&per_page=${LIMIT}&sort=updated&direction=desc`,
]);
if (!listRaw) {
  console.error("FAIL: `gh api` did not return a PR list — cannot measure.");
  process.exit(1);
}

const prs = (
  JSON.parse(listRaw) as Array<{ number: number; title: string; merged_at: string | null }>
)
  .filter((p) => p.merged_at !== null)
  .slice(0, LIMIT);

const rows: Row[] = [];
let noTask = 0;
let noSpec = 0;
let nothingToCompare = 0;
let pageCapped = 0;
let qualifiedTotal = 0;

for (const pr of prs) {
  const taskId = taskIdFromTitle(pr.title);
  if (!taskId) {
    noTask++;
    continue;
  }
  const spec = sh(["minsky", "tasks", "spec", "get", taskId]);
  if (!spec) {
    noSpec++;
    continue;
  }
  const { files: enumerated, inScopeBlock } = extractInScopeFiles(spec, { strict: true });
  if (enumerated.length === 0) {
    nothingToCompare++;
    continue;
  }
  // PAGINATE (PR #3340 R2). `per_page=100` is the API's cap, not the PR's size:
  // a single page silently truncates a larger PR, and every enumerated path in
  // the missing pages then reads as UNTOUCHED. That biases the flag rate the
  // wrong way — upward, the direction that would make this check look noisier
  // than it is — so the measurement SC6 rests on cannot use one page.
  //
  // Not hypothetical: PR #3253 in this repo has 188 files, and a one-page read
  // of it during this task's own planning returned exactly 100 with no
  // indication anything was missing.
  const changed: string[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const raw = sh([
      "gh",
      "api",
      `repos/${REPO}/pulls/${pr.number}/files?per_page=100&page=${page}`,
    ]);
    if (!raw) break;
    const batch = (JSON.parse(raw) as Array<{ filename: string }>).map((f) => f.filename);
    changed.push(...batch);
    if (batch.length < 100) break;
    if (page === MAX_FILE_PAGES) truncated = true;
  }
  // A PR past the page ceiling is EXCLUDED rather than measured on partial
  // data — an undercounted diff produces false flags, and a measurement that
  // silently includes them is worse than one that reports a smaller n.
  if (truncated) {
    pageCapped++;
    continue;
  }

  const { untouched, qualified } = untouchedEnumeratedPaths(inScopeBlock, enumerated, changed);
  qualifiedTotal += qualified;

  rows.push({
    pr: pr.number,
    taskId,
    enumerated,
    changed: changed.length,
    untouched,
    qualified,
  });
}

const flagged = rows.filter((r) => r.untouched.length > 0);

console.log(`merged PRs examined:            ${prs.length}`);
console.log(`  no task id in title:          ${noTask}`);
console.log(`  spec unfetchable:             ${noSpec}`);
console.log(`  nothing to compare (SC5):     ${nothingToCompare}`);
console.log(`  excluded, past page cap:      ${pageCapped}`);
console.log(`  comparable:                   ${rows.length}`);
console.log(`  FLAGGED (>=1 untouched path): ${flagged.length}`);
console.log(`  suppressed as QUALIFIED:      ${qualifiedTotal}`);
if (rows.length > 0) {
  console.log(
    `  flag rate over comparable:    ${((flagged.length / rows.length) * 100).toFixed(1)}%`
  );
}
console.log("\n--- flagged, for hand classification (SC6) ---");
for (const r of flagged) {
  console.log(
    `\nPR #${r.pr} (${r.taskId}) — ${r.untouched.length} of ${r.enumerated.length} untouched`
  );
  for (const u of r.untouched) {
    console.log(`  - ${u.path}`);
    if (u.line) console.log(`      spec: ${u.line.slice(0, 160)}`);
  }
}

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify({ prs: prs.length, rows, flagged: flagged.length }, null, 2)
  );
  console.log(`\nwrote ${JSON_OUT}`);
}

if (prs.length === 0) {
  console.error("FAIL: zero merged PRs resolved — nothing was measured.");
  process.exit(1);
}
