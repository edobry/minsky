#!/usr/bin/env bun
/**
 * Live verification for the diff-scope subset invariant (mt#3663).
 *
 * The unit tests for `resolveDiffScope` run against hand-built fixtures. This
 * runs the SAME production function against the REAL GitHub responses for the
 * incident that produced the task — PR #2587 — so the evidence covers the
 * actual payload shape (`previous_filename`, rename status, the real
 * `diff --git` header formatting) rather than a fixture's idea of it.
 *
 * A fixture cannot fail the way the live API can, which is the whole reason
 * this exists: the defect was a property of what GitHub's compare endpoint
 * RETURNS for a range containing a merge commit, not of any logic we wrote.
 *
 * ## Two cases, because they exercise opposite branches
 *
 * **Case A — the incident itself.** Base is the SHA the prior bot review was
 * posted against (`679f4524`), head is the merge commit (`1ae5bb128`). The PR's
 * own commits all predate the base, so the range contains ONLY base-branch
 * files: 157 of them, zero belonging to the PR. Correct behavior is the
 * full-diff FALLBACK — narrowing to nothing would hand the round an empty
 * review surface.
 *
 * **Case B — the survivor path.** Base is an earlier PR commit (`a3b1186b8`),
 * so the range spans both PR work and a merge-from-main: 200 files, exactly
 * one of which the PR touches. Correct behavior is to NARROW to that one file.
 * Without case B the probe would pass vacuously — every out-of-PR assertion in
 * case A is trivially satisfied by an empty result, which is exactly the shape
 * a broken intersection that dropped EVERYTHING would also produce.
 *
 * ## Built-in negative control
 *
 * Both cases first assert the defect still reproduces — the range is far wider
 * than the PR, its merge base equals its base (the three-dot collapse), and it
 * contains the specific paths the reviewer raised false findings against. If
 * GitHub ever changed compare semantics so the range stopped carrying
 * base-branch content, this script FAILS rather than silently "passing"
 * against a defect that no longer exists.
 *
 * ## This is an operator-run probe, not a CI check
 *
 * It reaches the live GitHub API, so it is gated on TWO things and skips (exit
 * 0) unless both are present:
 *
 *   1. `VERIFY_DIFF_SCOPE_RUN_LIVE=true` — an affirmative opt-in, matching the
 *      convention its sibling live probes in this directory already use (e.g.
 *      `SMOKE_ADOPTION_RUN_LIVE_SWEEP`). A token alone must not be sufficient:
 *      CI environments routinely carry `GITHUB_TOKEN`, so token-only gating
 *      would let a future workflow pick this up by accident.
 *   2. `GITHUB_TOKEN` — the credential for the reads below.
 *
 * What it costs and touches: about four read-only calls (`pulls.listFiles`,
 * the PR diff, and one `compareCommits` per case) against a PUBLIC repo, on
 * commits that are already merged. It performs no writes, and it never prints
 * the token — only file names, counts, and SHAs already visible in the PR.
 *
 * Usage:
 *   VERIFY_DIFF_SCOPE_RUN_LIVE=true GITHUB_TOKEN=$(gh auth token) \
 *     bun services/reviewer/scripts/verify-diff-scope-subset.ts
 */

import { Octokit } from "@octokit/rest";
import { resolveDiffScope } from "../src/incremental-diff-scope";
import type { PrFileEntry, IncrementalDiffResult } from "../src/github-client";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const OWNER = "edobry";
const REPO = "minsky";

/** The incident PR: mt#3622's seam migration. */
const PR_NUMBER = 2587;
/** The SHA the prior bot review (4850441895) was posted against — pre-merge. */
const CASE_A_BASE = "679f4524eda70efd43c07ee79eba4591defa6a81";
/** An earlier PR commit, so the range spans PR work AND a merge-from-main. */
const CASE_B_BASE = "a3b1186b8";
/** The merge-from-main commit HEAD pointed at for review 4850605423. */
const MERGE_HEAD_SHA = "1ae5bb128701e2a0384d5694d3c7694723d66152";

/**
 * Paths the reviewer raised findings against in review 4850605423, none of
 * which PR #2587 touches. Each landed on main from a different task.
 */
const FALSELY_FLAGGED_PATHS = [
  "src/adapters/shared/commands/memory/index.ts",
  "packages/domain/src/changeset/adapters/github-adapter.ts",
  "packages/domain/src/notify/principal-channel.ts",
  "src/cockpit/widgets/agents.ts",
];

interface Failure {
  case: string;
  check: string;
  detail: string;
}

const failures: Failure[] = [];

function check(caseName: string, checkName: string, ok: boolean, detail: string): void {
  if (!ok) failures.push({ case: caseName, check: checkName, detail });
}

function toPrFileEntries(
  files: ReadonlyArray<{
    filename: string;
    status?: string;
    additions?: number;
    deletions?: number;
    patch?: string;
    previous_filename?: string;
  }>
): PrFileEntry[] {
  return files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
    ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
  })) as PrFileEntry[];
}

async function main(): Promise<number> {
  // Opt-in first, credential second — see the header. Checking the opt-in
  // BEFORE the token means an environment that happens to carry GITHUB_TOKEN
  // (every GitHub Actions job does) still skips with a message naming the
  // switch, rather than silently spending API calls.
  if (process.env.VERIFY_DIFF_SCOPE_RUN_LIVE !== "true") {
    console.log(
      "SKIP: live probe not enabled. Set VERIFY_DIFF_SCOPE_RUN_LIVE=true to run it " +
        "(operator-run only; it reaches the live GitHub API)."
    );
    return 0;
  }

  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token.trim() === "") {
    console.log("SKIP: GITHUB_TOKEN not set — cannot reach the GitHub API.");
    return 0;
  }

  const octokit = new Octokit({ auth: token });

  // The PR's own files: merge-base-relative, per GitHub's "pull requests show
  // a three-dot diff" semantics. This is the authority on what the PR contains.
  const prFiles = toPrFileEntries(
    await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: OWNER,
      repo: REPO,
      pull_number: PR_NUMBER,
      per_page: 100,
    })
  );
  const prNames = new Set(prFiles.map((f) => f.filename));

  const { data: rawPrDiff } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner: OWNER,
      repo: REPO,
      pull_number: PR_NUMBER,
      mediaType: { format: "diff" },
    }
  );
  const prDiffText = String(rawPrDiff);

  const cases: Array<Record<string, unknown>> = [];

  for (const [caseName, base, expectedSource] of [
    ["A-incident", CASE_A_BASE, "full"],
    ["B-survivors", CASE_B_BASE, "incremental"],
  ] as const) {
    const comparison = await octokit.rest.repos.compareCommits({
      owner: OWNER,
      repo: REPO,
      base,
      head: MERGE_HEAD_SHA,
    });
    const rangeFiles = toPrFileEntries(comparison.data.files ?? []);
    const rangeNames = new Set(rangeFiles.map((f) => f.filename));
    const mergeCommitCount = (comparison.data.commits ?? []).filter(
      (c) => (c.parents?.length ?? 0) > 1
    ).length;

    // --- Negative control: the defect must still reproduce -------------------
    check(
      caseName,
      "defect-reproduces",
      rangeFiles.length > prFiles.length,
      `range returned ${rangeFiles.length} files vs the PR's ${prFiles.length}; the range no ` +
        "longer carries base-branch content, so this probe cannot distinguish a working fix " +
        "from a vanished defect"
    );
    check(
      caseName,
      "three-dot-collapse",
      comparison.data.merge_base_commit?.sha?.startsWith(base.slice(0, 9)) === true,
      `merge base is ${comparison.data.merge_base_commit?.sha}, expected the compare base ` +
        `${base} — the collapse this defect depends on is not present`
    );
    check(
      caseName,
      "merge-commit-in-range",
      mergeCommitCount > 0,
      "no merge commit in range; this range cannot exhibit the defect"
    );
    const flaggedInRange = FALSELY_FLAGGED_PATHS.filter((p) => rangeNames.has(p));
    check(
      caseName,
      "flagged-paths-in-range",
      flaggedInRange.length === FALSELY_FLAGGED_PATHS.length,
      `expected all ${FALSELY_FLAGGED_PATHS.length} falsely-flagged paths in range, found ` +
        `${flaggedInRange.length}`
    );
    const flaggedInPr = FALSELY_FLAGGED_PATHS.filter((p) => prNames.has(p));
    check(
      caseName,
      "flagged-paths-are-out-of-pr",
      flaggedInPr.length === 0,
      `these are actually in the PR, so they were never false: ${flaggedInPr.join(", ")}`
    );

    // --- The production function, end to end, on live data ------------------
    const incremental: IncrementalDiffResult = {
      diff: "unused: resolveDiffScope sources content from the PR's own diff",
      fileEntries: rangeFiles,
    };
    const resolved = await resolveDiffScope({
      enabled: true,
      priorReviewCommitId: base,
      headSha: MERGE_HEAD_SHA,
      fullDiff: prDiffText,
      fullFileEntries: prFiles,
      fetchIncremental: async () => incremental,
      prNumber: PR_NUMBER,
    });

    check(
      caseName,
      "expected-source",
      resolved.source === expectedSource,
      `resolveDiffScope returned source="${resolved.source}", expected "${expectedSource}"`
    );

    // The invariant itself, on whichever branch was taken.
    const escaped = resolved.fileEntries.map((f) => f.filename).filter((n) => !prNames.has(n));
    check(
      caseName,
      "subset-invariant",
      escaped.length === 0,
      `files outside the PR reached the review surface: ${escaped.join(", ")}`
    );
    const flaggedInOutput = FALSELY_FLAGGED_PATHS.filter((p) => resolved.diff.includes(p));
    check(
      caseName,
      "no-flagged-path-in-output",
      flaggedInOutput.length === 0,
      `the emitted diff mentions out-of-PR paths: ${flaggedInOutput.join(", ")}`
    );
    check(
      caseName,
      "non-empty-surface",
      resolved.fileEntries.length > 0 && resolved.diff.trim().length > 0,
      "the round would be shown an empty diff"
    );

    if (expectedSource === "incremental") {
      // Case B only: narrowing must actually narrow, and the content shown must
      // be the PR's own patch for the survivor.
      check(
        caseName,
        "actually-narrowed",
        resolved.fileEntries.length < prFiles.length,
        `narrowed to ${resolved.fileEntries.length} of the PR's ${prFiles.length} files — ` +
          "no narrowing occurred"
      );
      const survivor = resolved.fileEntries[0]?.filename;
      check(
        caseName,
        "survivor-section-present",
        survivor !== undefined && resolved.diff.includes(survivor),
        `the emitted diff does not contain a section for the survivor ${survivor}`
      );
      // Every emitted section must be a verbatim slice of the PR's own diff. A
      // section sourced from the compare response instead would carry
      // base-branch hunks for a file the PR also touches — the case a
      // filename-only filter cannot catch.
      const emittedHeaders = resolved.diff
        .split("\n")
        .filter((line) => line.startsWith("diff --git "));
      check(
        caseName,
        "content-is-pr-relative",
        emittedHeaders.length > 0 && emittedHeaders.every((h) => prDiffText.includes(h)),
        `emitted section headers absent from the PR's own diff: ${
          emittedHeaders.filter((h) => !prDiffText.includes(h)).join(", ") || "(none emitted)"
        }`
      );
    }

    cases.push({
      case: caseName,
      base,
      head: MERGE_HEAD_SHA,
      rangeFileCount: rangeFiles.length,
      rangeCommitCount: comparison.data.commits?.length ?? 0,
      rangeMergeCommitCount: mergeCommitCount,
      mergeBaseEqualsBase: comparison.data.merge_base_commit?.sha,
      resolvedSource: resolved.source,
      resolvedFileCount: resolved.fileEntries.length,
      resolvedFiles: resolved.fileEntries.map((f) => f.filename),
      droppedFileCount: rangeFiles.length - resolved.fileEntries.length,
      resolvedDiffChars: resolved.diff.length,
    });
  }

  const result = {
    pr: PR_NUMBER,
    prFileCount: prFiles.length,
    prDiffChars: prDiffText.length,
    cases,
    failures,
    status: failures.length === 0 ? "PASS" : "FAIL",
  };

  console.log(JSON.stringify(result, null, 2));
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("FAIL:", getLoggableErrorSummary(err));
    process.exit(1);
  });
