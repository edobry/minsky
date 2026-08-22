#!/usr/bin/env bun
/**
 * Live verification for mt#4422's `git.log` path precondition.
 *
 * The unit tests inject the subprocess and assert the DECISION (count 0 rejects,
 * count > 0 allows, a broken probe allows). They deliberately assert nothing
 * about git itself, because a double reproducing git's behaviour would be
 * asserting a model of git rather than git (ADR-036). This script checks that
 * other half against a REAL repository — including the premise the whole task
 * rests on, which is git's and not Minsky's:
 *
 *   `git log -- <pathspec-that-matches-nothing>` exits 0 with EMPTY output.
 *
 * If that ever stopped being true, mt#4422's defect would not exist and this
 * precondition would be pointless — so it is checked first, and a failure here
 * is a finding, not a flake.
 *
 * Read-only: every command is a `git log` / `rev-list` / `ls-files` read.
 *
 * Usage:
 *   bun scripts/verify-git-log-path-precondition.ts [repoPath]
 *
 * Exit codes:
 *   0 — all cases behaved as designed
 *   1 — at least one case did NOT (details in the JSON `failures` array)
 *   2 — the check did not complete (never conflated with a clean pass)
 */

import { execAsync } from "@minsky/shared/exec";
import { probeGitLogPathHistory } from "../src/adapters/shared/commands/git";

interface CaseResult {
  name: string;
  path: string;
  revListCount: number | null;
  trackedNow: boolean;
  verdict: "matched" | "unmatched" | "unchecked";
  expected: "matched" | "unmatched";
  ok: boolean;
}

async function revListCount(repo: string, path: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`git -C '${repo}' rev-list --all --count -- '${path}'`);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function isTrackedNow(repo: string, path: string): Promise<boolean> {
  try {
    await execAsync(`git -C '${repo}' ls-files --error-unmatch -- '${path}'`);
    return true;
  } catch {
    return false;
  }
}

async function runCase(
  repo: string,
  name: string,
  path: string,
  expected: "matched" | "unmatched"
): Promise<CaseResult> {
  const [count, tracked] = await Promise.all([revListCount(repo, path), isTrackedNow(repo, path)]);

  const probed = await probeGitLogPathHistory({ repo, path });
  // "unchecked" is kept distinct from "unmatched" here for the same reason the
  // verdict type keeps them apart: a probe that could not run must never be
  // scored as a clean unmatched.
  const verdict: CaseResult["verdict"] = !probed.checked
    ? "unchecked"
    : probed.matched
      ? "matched"
      : "unmatched";

  return {
    name,
    path,
    revListCount: count,
    trackedNow: tracked,
    verdict,
    expected,
    ok: verdict === expected,
  };
}

async function main(): Promise<number> {
  const repo = process.argv[2] ?? process.cwd();

  // ---- The premise, checked first. This is git's behaviour, not Minsky's. ----
  const NEVER_EXISTED = "src/mt4422-path-that-never-existed.ts";
  const { stdout: emptyLog } = await execAsync(
    `git -C '${repo}' log --oneline -n 5 -- '${NEVER_EXISTED}'`
  );
  const premiseHolds = emptyLog.trim() === "";

  // A path that is deleted but retains history is what makes `ls-files
  // --error-unmatch` the WRONG check. Derived from this repo's own history
  // rather than hard-coded, so the fixture cannot silently stop being one.
  const { stdout: deletedRaw } = await execAsync(
    `git -C '${repo}' log --diff-filter=D --name-only --pretty=format: -n 400 | grep -v '^$' | head -1`
  );
  const deletedWithHistory = deletedRaw.trim();

  const cases: CaseResult[] = [];
  cases.push(await runCase(repo, "tracked, with history", "package.json", "matched"));
  if (deletedWithHistory) {
    cases.push(await runCase(repo, "deleted, with history", deletedWithHistory, "matched"));
  }
  cases.push(await runCase(repo, "never existed", NEVER_EXISTED, "unmatched"));
  cases.push(
    await runCase(repo, "space-separated path LIST", "package.json tsconfig.json", "unmatched")
  );

  const failures: string[] = [];
  if (!premiseHolds) {
    failures.push(
      "PREMISE BROKEN: `git log -- <unmatched pathspec>` produced output. " +
        "mt#4422's defect does not exist in this git version; re-derive before trusting this precondition."
    );
  }
  if (!deletedWithHistory) {
    failures.push(
      "Could not derive a deleted-with-history path from the last 400 commits — " +
        "the case that distinguishes rev-list from ls-files went UNCHECKED (not passed)."
    );
  }
  for (const c of cases) {
    if (!c.ok) {
      failures.push(
        `${c.name} ('${c.path}'): expected ${c.expected}, got ${c.verdict} ` +
          `(rev-list count ${c.revListCount}, tracked now: ${c.trackedNow})`
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        repo,
        gitLogEmptyOnUnmatchedPathspec: premiseHolds,
        deletedWithHistoryFixture: deletedWithHistory || null,
        cases,
        verdict: failures.length === 0 ? "as-designed" : "MISMATCH",
        failures,
      },
      null,
      2
    )
  );

  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Exit 2, never 1: "the check did not run" must not read as "the check failed".
    console.error("verify-git-log-path-precondition: check did not complete —", err);
    process.exit(2);
  });
