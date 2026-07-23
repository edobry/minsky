/**
 * Commit deletion-count computation (mt#3021 SC3).
 *
 * Computes how many tracked files a commit DELETED relative to its first
 * parent — the metric the mass-deletion sanity gate thresholds against.
 * Extracted as its own small, independently-testable module (rather than
 * inlined in `sessionCommit`) because mt#1691 (`session_commit --dryRun`
 * staged-file preview) shares the same staged-delta inspection surface and
 * is expected to reuse this computation rather than re-deriving it.
 *
 * Deliberately counts DELETED FILES (git `D` name-status), not line
 * deletions or "files changed" — see the mt#3021 spec's "Layer-1 design
 * decisions" §Threshold: "raw deletion COUNT, not net files-changed." A
 * commit that modifies 200 files and deletes 10 should trip on 10, not 210.
 *
 * Diffs against the FIRST parent only (`<ref>^1`), which is the correct
 * comparison for both regular commits (first parent = only parent) and merge
 * commits: it answers "did this commit remove files that were already on
 * THIS branch", ignoring content differences that come from the OTHER merge
 * parent (e.g. legitimate new files from main) — exactly the mt#3021
 * incident shape (branch tip `d0566fbaa` vs merge commit `2d9d5567`, which
 * dropped `Dockerfile`/`LICENSE`/`infra/**`/etc. relative to the branch's own
 * prior tip).
 *
 * Rename detection (`-M -C`) is enabled so a genuine rename does NOT count
 * as a deletion — per the spec's design decision, the gate does not attempt
 * to classify intent beyond that: a rename-detection MISS (git fails to
 * recognize a heavily-modified move as a rename) still counts as a
 * deletion+addition pair, by design — see the spec's "the gate does not
 * classify intent" section for why that is intentionally NOT special-cased.
 */
import { safeShellQuote } from "@minsky/shared/exec";
import type { GitServiceInterface } from "./types";

export interface CommitDeletionStats {
  /** Count of files with `D` name-status in `<ref>^1..<ref>`. */
  deletionCount: number;
  /** First N deleted paths, for a refusal message / audit payload — not exhaustive. */
  sampleDeletedPaths: string[];
}

const SAMPLE_PATH_LIMIT = 20;

/**
 * Compute deletion stats for `ref` (default `HEAD`) relative to its first
 * parent. Returns `null` when there is no resolvable first parent (a root
 * commit) — nothing to compare against, so the caller should treat this as
 * "skip the check," not "check failed."
 */
export async function computeCommitDeletionStats(
  gitService: Pick<GitServiceInterface, "execInRepository">,
  workdir: string,
  ref: string = "HEAD"
): Promise<CommitDeletionStats | null> {
  let parent: string;
  try {
    parent = (
      await gitService.execInRepository(
        workdir,
        `git rev-parse --verify --end-of-options ${safeShellQuote(`${ref}^1`)}`
      )
    ).trim();
  } catch {
    // Root commit (no parent) or otherwise unresolvable — nothing to diff.
    return null;
  }
  if (!parent) return null;

  const nameStatus = await gitService.execInRepository(
    workdir,
    `git diff --name-status -M -C ${safeShellQuote(parent)} ${safeShellQuote(ref)}`
  );

  const deletedPaths = nameStatus
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^D\s/.test(line))
    .map((line) => line.replace(/^D\s+/, ""));

  return {
    deletionCount: deletedPaths.length,
    sampleDeletedPaths: deletedPaths.slice(0, SAMPLE_PATH_LIMIT),
  };
}

/**
 * Calibrated threshold (mt#3021): count of deleted files in a single
 * commit's staged delta above which the mass-deletion sanity gate refuses to
 * push absent an override.
 *
 * Calibration data (2026-07-23, this repo, verified live):
 *   - Repo tracks 3,500 files (`git ls-files | wc -l`).
 *   - The incident commit deleted ~281 files (~8% of the tree) — the spec's
 *     own order-of-magnitude anchor.
 *   - Sampled real commits from this repo's history (a mix of large merges
 *     and refactor commits — `0af335c36` a 29-commit merge-conflict
 *     resolution, `6f91bc05f`/`db084bb45`/`bf91ce58e` multi-file pipeline
 *     cutovers) topped out at 67 files TOUCHED in the largest sample, most
 *     of which were modifications (more insertions than deletions), not
 *     pure deletions — actual deleted-file counts in normal large commits in
 *     this repo's history are in the low single digits to low tens, nowhere
 *     near 100.
 *
 * 100 sits at roughly 3% of the tracked-file count, ~2.8x below the incident
 * magnitude, and comfortably above every legitimately-large commit sampled —
 * an intentionally generous margin on both sides given the gate's own
 * design decision that it must never classify intent (a false positive on a
 * legitimate large deletion costs one override call; a false negative lets
 * an incident-shaped push through silently).
 */
export const DEFAULT_MASS_DELETION_THRESHOLD = 100;
