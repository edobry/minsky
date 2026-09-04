/**
 * Reconstruct a unified diff from per-file patches when GitHub refuses to serve
 * the whole-PR diff (mt#4434).
 *
 * ## Why this exists
 *
 * `GET /repos/{owner}/{repo}/pulls/{n}` with a diff/patch media type is capped
 * TWICE, and both caps return **406** with `errors[].code === "too_large"`:
 *
 * - **20,000 lines** — hit by PR #3253 (188 files / 85,606 insertions).
 * - **300 files** — hit by PR #3412 (313 files / 1,504 insertions).
 *
 * The two are independent: #3412 is comfortably under the line cap and over the
 * file cap. So the trigger is the STATUS plus the ERROR CODE, never a size
 * threshold of our own — GitHub may add a third cap, and a size-keyed check
 * would silently stop matching.
 *
 * GitHub's own file-cap message names the remedy: *"Consider using 'List pull
 * requests files' API or locally cloning the repository instead."* The reviewer
 * already calls that API (`fetchListFiles`, mt#2120) on every review, so the
 * per-file patches are in hand before this module is reached; the work here is
 * assembling them back into the unified-diff text the rest of the pipeline
 * consumes.
 *
 * ## What the output has to satisfy
 *
 * `pr.diff` is not free-form — `parseRightSideAnchorableLines`
 * (`anchor-validation.ts`) parses it to decide which lines an inline comment may
 * anchor to, and an unanchorable comment is silently demoted into the review
 * body. So a malformed reconstruction degrades review quality without erroring.
 * The emitted shape is therefore exactly what that parser reads:
 *
 * ```
 * diff --git a/<old> b/<new>
 * --- a/<old>            ("/dev/null" when the file was added)
 * +++ b/<new>            ("/dev/null" when the file was removed)
 * @@ -old,count +new,count @@     <- from GitHub's per-file `patch`
 *  context / +added / -removed
 * ```
 */

import type { PrFileEntry } from "./github-client";

/** Marker GitHub returns for a file with no left or right side. */
const DEV_NULL = "/dev/null";

/**
 * Result of a reconstruction, carrying counts rather than only the text.
 *
 * The counts exist so a caller — and a test — can assert the reconstruction
 * actually PRODUCED something. Asserting only "no error was thrown" passes
 * identically when every file was skipped, which is mem#853's vacuous-probe
 * shape: the assertion is trivially true of an empty set.
 */
export interface DiffReconstruction {
  /** The assembled unified diff. Empty string when no entry carried a patch. */
  diff: string;
  /** Files whose `patch` was present and emitted as hunks. */
  filesWithPatch: number;
  /**
   * Files GitHub declined to give a patch for — binary, or over the
   * contents-API size cap (mt#3018). Named rather than counted: a reviewer that
   * cannot see a file's content should at least know which file it was.
   */
  filesWithoutPatch: string[];
}

/**
 * True when an error is GitHub's "this diff is too large to serve" refusal.
 *
 * Keyed on the status AND the `too_large` code, never on the status alone: a
 * bare 406 has other causes, and swallowing those would convert an unrelated
 * failure into a silently degraded review.
 *
 * Both carriers of the code are checked. Octokit exposes the parsed array at
 * `response.data.errors`, which is the precise signal; it ALSO folds the
 * serialized array into the message (observed in production:
 * `"Sorry, the diff exceeded the maximum number of files (300). …:
 * {\"resource\":\"PullRequest\",\"field\":\"diff\",\"code\":\"too_large\"}"`).
 * The message check is the fallback for wrappers that drop the structured
 * response. It matches the SERIALIZED `"code":"too_large"` pair rather than a
 * bare `too_large` substring (PR #3609 R1) — the loose form would also match a
 * message that merely mentions the token. The 406 is required either way.
 */
export function isDiffTooLargeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const status = "status" in err ? (err as { status?: unknown }).status : undefined;
  if (status !== 406) return false;

  const response = "response" in err ? (err as { response?: unknown }).response : undefined;
  const data =
    response && typeof response === "object" && "data" in response
      ? (response as { data?: unknown }).data
      : undefined;
  const errors =
    data && typeof data === "object" && "errors" in data
      ? (data as { errors?: unknown }).errors
      : undefined;

  if (Array.isArray(errors)) {
    const coded = errors.some(
      (e) => e && typeof e === "object" && (e as { code?: unknown }).code === "too_large"
    );
    if (coded) return true;
  }

  // PR #3609 R1: match the SERIALIZED error object Octokit appends to the
  // message, not a bare "too_large" substring. The loose form would also match
  // a message that merely mentions the token — a quoted upstream error, a PR
  // title — and a false positive here silently degrades a review that should
  // have failed loudly.
  return /"code"\s*:\s*"too_large"/.test(err.message);
}

/**
 * Choose the `--- a/…` and `+++ b/…` header paths for one file entry.
 *
 * A rename carries its old path in `previousFilename`; using the new path on
 * both sides would misreport the change. An add has no left side and a removal
 * has no right side, and `/dev/null` is how the parser recognises each — in
 * particular a `+++ /dev/null` makes the parser refuse to anchor comments to a
 * deleted file, which is correct.
 */
function headerPaths(entry: PrFileEntry): { left: string; right: string } {
  const previous = entry.previousFilename ?? entry.filename;

  if (entry.status === "added") {
    return { left: DEV_NULL, right: `b/${entry.filename}` };
  }
  if (entry.status === "removed") {
    return { left: `a/${previous}`, right: DEV_NULL };
  }
  return { left: `a/${previous}`, right: `b/${entry.filename}` };
}

/**
 * Assemble a unified diff from per-file entries.
 *
 * Files whose `patch` GitHub omitted still get a `diff --git` header plus an
 * explanatory line, rather than being dropped. Dropping them would leave the
 * reviewer unable to distinguish "this file was not changed" from "this file
 * was changed and I was not shown it" — and the second is exactly the condition
 * a reviewer should not silently review around. The explanatory line sits
 * outside any hunk, so `parseRightSideAnchorableLines` skips it: after a
 * `diff --git` it clears its state and ignores everything until the next
 * `+++`/`@@` pair.
 */
export function reconstructDiff(entries: readonly PrFileEntry[]): DiffReconstruction {
  const parts: string[] = [];
  const filesWithoutPatch: string[] = [];
  let filesWithPatch = 0;

  for (const entry of entries) {
    const previous = entry.previousFilename ?? entry.filename;
    const { left, right } = headerPaths(entry);

    parts.push(`diff --git a/${previous} b/${entry.filename}`);

    // Header pair is emitted for EVERY file, patch or not (PR #3609 R1), so
    // each block has the same shape and a consumer cannot mistake a patch-less
    // entry for a malformed one. With no `@@` following, the parser sets the
    // current file and never enters a hunk, so it offers no anchors — which is
    // correct for content it was not shown.
    parts.push(`--- ${left}`);
    parts.push(`+++ ${right}`);

    if (entry.patch === undefined || entry.patch === "") {
      filesWithoutPatch.push(entry.filename);
      parts.push(
        `# patch unavailable (${entry.status}, +${entry.additions}/-${entry.deletions}) — ` +
          "GitHub omits the patch for binary files and files over its size cap (mt#3018)"
      );
      continue;
    }

    // GitHub's `patch` starts at the first `@@` hunk header and carries no
    // trailing newline, so the join below supplies the separator.
    parts.push(entry.patch);
    filesWithPatch += 1;
  }

  return {
    diff: parts.length > 0 ? `${parts.join("\n")}\n` : "",
    filesWithPatch,
    filesWithoutPatch,
  };
}
