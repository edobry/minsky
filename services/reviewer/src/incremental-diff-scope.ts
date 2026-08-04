/**
 * Incremental diff-since-last-review scope resolution (mt#3471).
 *
 * Every review round re-sends the ENTIRE PR diff today, so a PR costs
 * O(rounds x full diff). Re-review rounds are ~68% of all reviewer LLM calls
 * and ~68% of spend, and their median input (412K tokens) is only ~7% below a
 * first review's (444K) — the rounds that should be cheapest are nearly as
 * expensive as the first look.
 *
 * This module decides what a round is shown: the PR's changes to the files
 * touched since the last posted review when that range resolves, and the full
 * PR diff whenever it does not. The prior review's findings stay in the prompt
 * (`priorReviewsMarkdown`) regardless, and the file-reading tools still resolve
 * at HEAD, so narrowing removes re-sent context rather than removing reach.
 *
 * Split out of review-worker.ts so the branch table is directly unit-testable —
 * the same convention as `decideToolsActive` / `decidePostSanitizeOutcome`.
 *
 * ## The subset invariant (mt#3663)
 *
 * Whatever this module returns MUST be a subset of the PR's merge-base diff.
 * The incremental range answers a BRANCH-HISTORY question ("which files changed
 * since the last review"), which is not the same question as "what did this PR
 * introduce" — GitHub answers the latter with a three-dot, merge-base-relative
 * diff, and a pull request IS that diff.
 *
 * The two answers diverge whenever the branch absorbs commits it did not
 * author. The compare base is the last review's commit SHA, which is an
 * ancestor of HEAD on the PR branch, so `base...head` collapses to `base..head`
 * — and a merge-from-main commit in that range drags every file main touched
 * into the range with it. On PR #2587 that turned a 6-file PR into a 157-file
 * review surface and produced BLOCKING findings against four files the PR never
 * touched.
 *
 * So the incremental compare is used ONLY to select which files to show; the
 * content shown for each is taken from the PR's own merge-base entries. Note
 * that filtering by filename alone is NOT sufficient: a conflict-resolution
 * merge touches exactly the files the PR touches, so a file can be in both sets
 * while the compare's patch for it carries main's changes.
 */

import type { PrFileEntry, IncrementalDiffResult } from "./github-client";
import { log } from "./logger";

/** How a round's diff scope was resolved. */
export type DiffScopeSource =
  /** Narrowed to the PR's changes to the files touched since the last review. */
  | "incremental"
  /** The full PR diff — the flag is off, or nothing narrower was resolvable. */
  | "full";

export interface ResolveDiffScopeInput {
  /** REVIEWER_INCREMENTAL_DIFF_ENABLED, already parsed. */
  enabled: boolean;
  /** The most recent prior review's `commit_id`; undefined on R1 or when absent. */
  priorReviewCommitId: string | undefined;
  /** Current PR HEAD sha. */
  headSha: string;
  /** The whole-PR diff, used whenever narrowing does not apply. */
  fullDiff: string;
  /** The whole-PR file entries, used whenever narrowing does not apply. */
  fullFileEntries: PrFileEntry[];
  /**
   * Fetches the diff between two SHAs. Returns undefined when the range is
   * unresolvable; may also throw (an injected fetcher, a future variant).
   */
  fetchIncremental: (
    baseSha: string,
    headSha: string
  ) => Promise<IncrementalDiffResult | undefined>;
  /** PR number, for log correlation only. */
  prNumber: number;
}

export interface ResolveDiffScopeResult {
  /** The diff this round should be shown. */
  diff: string;
  /** The file entries matching `diff` — chunked review packs from these. */
  fileEntries: PrFileEntry[];
  /** Which branch produced the above. */
  source: DiffScopeSource;
}

/** The `diff --git` line that opens each file's section in a unified diff. */
const DIFF_SECTION_HEADER_PREFIX = "diff --git ";

/**
 * Restrict `incrementalFiles` to files the PR itself changed, and return the
 * PR's OWN entry for each survivor (mt#3663).
 *
 * Returning the PR's entry rather than the incremental one is the load-bearing
 * half: the incremental entry's `patch` is relative to the last-reviewed SHA
 * and can contain changes merged in from the base branch, while the PR entry's
 * patch is merge-base-relative and therefore contains only what the PR
 * introduced.
 *
 * A rename is matched on either side of the rename, since the two views of the
 * PR may disagree about which name a file currently has.
 *
 * Order follows the PR's own file order, so the resulting scope reads the same
 * way the full diff does. Pure function; exported for unit testing.
 */
export function intersectWithPrFiles(
  incrementalFiles: readonly PrFileEntry[],
  prFiles: readonly PrFileEntry[]
): PrFileEntry[] {
  const prByName = new Map<string, PrFileEntry>();
  for (const file of prFiles) {
    prByName.set(file.filename, file);
    if (file.previousFilename !== undefined) prByName.set(file.previousFilename, file);
  }

  const keptNames = new Set<string>();
  for (const incremental of incrementalFiles) {
    const prEntry =
      prByName.get(incremental.filename) ??
      (incremental.previousFilename !== undefined
        ? prByName.get(incremental.previousFilename)
        : undefined);
    if (prEntry !== undefined) keptNames.add(prEntry.filename);
  }

  return prFiles.filter((file) => keptNames.has(file.filename));
}

/**
 * Extract the per-file sections of `diff` whose header names one of
 * `filenames`, preserving the input's exact formatting (mt#3663).
 *
 * Selecting sections out of the PR's own diff rather than rebuilding them from
 * per-file patches means the narrowed diff is byte-identical to the
 * corresponding slice of what the full-diff branch would have shown, so the two
 * branches cannot drift in formatting.
 *
 * A section is matched by testing whether its header ends with ` b/<name>`,
 * which avoids parsing `diff --git a/X b/Y` — unparseable in general, since
 * paths may contain spaces. A path git chose to quote will not match and is
 * simply left out; the caller treats an empty result as "cannot narrow" and
 * falls back to the full diff, so a miss costs tokens rather than coverage.
 *
 * Pure function; exported for unit testing.
 */
export function selectDiffSectionsForFiles(diff: string, filenames: ReadonlySet<string>): string {
  if (filenames.size === 0) return "";

  const lines = diff.split("\n");
  const kept: string[] = [];
  let keepingCurrentSection = false;

  for (const line of lines) {
    if (line.startsWith(DIFF_SECTION_HEADER_PREFIX)) {
      keepingCurrentSection = false;
      for (const name of filenames) {
        if (line.endsWith(` b/${name}`)) {
          keepingCurrentSection = true;
          break;
        }
      }
    }
    if (keepingCurrentSection) kept.push(line);
  }

  return kept.join("\n");
}

/**
 * Resolve the diff scope for one review round.
 *
 * Falls back to the full PR diff — never to a partial or empty scope — when the
 * flag is off, there is no prior review to scope against, the range is
 * unresolvable (force-push orphaned the base, the comparison was truncated or
 * 5xx'd), the fetch throws, or the range shares no files with the PR itself.
 * Reviewing the full diff again is a cost regression; reviewing a wrongly-scoped
 * diff is a correctness regression, so every ambiguous case takes the cost hit.
 *
 * Never throws.
 */
export async function resolveDiffScope(
  input: ResolveDiffScopeInput
): Promise<ResolveDiffScopeResult> {
  const {
    enabled,
    priorReviewCommitId,
    headSha,
    fullDiff,
    fullFileEntries,
    fetchIncremental,
    prNumber,
  } = input;

  const full: ResolveDiffScopeResult = {
    diff: fullDiff,
    fileEntries: fullFileEntries,
    source: "full",
  };

  if (!enabled || priorReviewCommitId === undefined) return full;

  let incremental: IncrementalDiffResult | undefined;
  try {
    incremental = await fetchIncremental(priorReviewCommitId, headSha);
  } catch (err: unknown) {
    // fetchIncrementalDiffSince swallows its own errors and returns undefined;
    // this covers an injected fetcher (or a future variant) that throws.
    const message = err instanceof Error ? err.message : String(err);
    log.warn("reviewer.incremental_diff_failed", {
      event: "reviewer.incremental_diff_failed",
      pr: prNumber,
      baseSha: priorReviewCommitId,
      headSha,
      error: message,
    });
    return full;
  }

  if (incremental === undefined) {
    // Distinct from the failure log above: this is the DESIGNED fallback (no
    // new commits, orphaned base, truncated or 5xx comparison), not an error.
    log.info("reviewer.incremental_diff_fallback_full", {
      event: "reviewer.incremental_diff_fallback_full",
      pr: prNumber,
      baseSha: priorReviewCommitId,
      headSha,
    });
    return full;
  }

  // mt#3663: hold the subset invariant. The compare range can carry files the
  // PR never touched (a merge-from-main in range brings the base branch's own
  // changes with it), and its patches for shared files can carry base-branch
  // content, so both the file set and the content come from the PR's entries.
  const narrowedFileEntries = intersectWithPrFiles(incremental.fileEntries, fullFileEntries);
  const narrowedNames = new Set(narrowedFileEntries.map((file) => file.filename));
  const narrowedDiff = selectDiffSectionsForFiles(fullDiff, narrowedNames);
  const outOfPrFileCount = incremental.fileEntries.length - narrowedFileEntries.length;

  if (narrowedFileEntries.length === 0 || narrowedDiff.trim().length === 0) {
    // Every file in range was out-of-PR, or none of the survivors could be
    // located in the PR diff. Either way there is nothing safe to narrow TO.
    log.info("reviewer.incremental_diff_fallback_full", {
      event: "reviewer.incremental_diff_fallback_full",
      pr: prNumber,
      baseSha: priorReviewCommitId,
      headSha,
      reason: "no_in_pr_files_in_range",
      incrementalFileCount: incremental.fileEntries.length,
      outOfPrFileCount,
    });
    return full;
  }

  log.info("reviewer.incremental_diff_applied", {
    event: "reviewer.incremental_diff_applied",
    pr: prNumber,
    baseSha: priorReviewCommitId,
    headSha,
    fullDiffChars: fullDiff.length,
    incrementalDiffChars: narrowedDiff.length,
    fullFileCount: fullFileEntries.length,
    incrementalFileCount: narrowedFileEntries.length,
    // How many files the compare range carried that the PR does not touch.
    // Non-zero means the subset invariant just prevented a review of
    // base-branch content — the mt#3663 defect, measured rather than assumed.
    outOfPrFileCount,
  });

  return {
    diff: narrowedDiff,
    fileEntries: narrowedFileEntries,
    source: "incremental",
  };
}
