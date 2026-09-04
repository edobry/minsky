/**
 * Tests for the too-large-diff detection and reconstruction (mt#4434).
 *
 * The reconstruction assertions deliberately run the REAL downstream consumer —
 * `parseRightSideAnchorableLines` from `anchor-validation.ts` — rather than
 * matching the emitted text against a string this file also authored. That
 * parser decides which lines an inline comment may anchor to, and an
 * unanchorable comment is silently demoted into the review body, so a
 * malformed reconstruction degrades review quality without raising anything.
 * Asserting the format against itself would pass just as well for a shape the
 * parser cannot read.
 */

import { describe, expect, test } from "bun:test";
import { isDiffTooLargeError, reconstructDiff } from "./diff-reconstruction";
import { parseRightSideAnchorableLines } from "./anchor-validation";
import type { PrFileEntry } from "./github-client";

/** Build an Octokit `RequestError`-shaped value. */
function octokitError(
  status: number,
  message: string,
  errors?: ReadonlyArray<Record<string, unknown>>
): Error {
  const err = new Error(message) as Error & { status: number; response?: unknown };
  err.status = status;
  if (errors) err.response = { data: { errors } };
  return err;
}

/**
 * The two messages GitHub actually returned, copied from the production logs
 * for PR #3253 (line cap) and PR #3412 (file cap). Using the observed strings
 * rather than invented ones is what makes the message-fallback branch a test of
 * reality instead of a test of my guess about it.
 */
const LINE_CAP_MESSAGE =
  'Sorry, the diff exceeded the maximum number of lines (20000): {"resource":"PullRequest",' +
  '"field":"diff","code":"too_large"}';
const FILE_CAP_MESSAGE =
  "Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull " +
  'requests files\' API or locally cloning the repository instead.: {"resource":"PullRequest",' +
  '"field":"diff","code":"too_large"}';

const TOO_LARGE_ERRORS = [{ resource: "PullRequest", field: "diff", code: "too_large" }];

describe("isDiffTooLargeError", () => {
  test("recognises the LINE cap (PR #3253) from the structured errors array", () => {
    expect(isDiffTooLargeError(octokitError(406, LINE_CAP_MESSAGE, TOO_LARGE_ERRORS))).toBe(true);
  });

  test("recognises the FILE cap (PR #3412) — a different cap, same code", () => {
    // The two caps are independent: #3412 is well under 20,000 lines and over
    // 300 files. Keying on the code rather than on a size is what makes one
    // branch cover both, and what will cover a third cap if GitHub adds one.
    expect(isDiffTooLargeError(octokitError(406, FILE_CAP_MESSAGE, TOO_LARGE_ERRORS))).toBe(true);
  });

  test("falls back to the message when the structured response is absent", () => {
    // Some wrappers surface only the message. The 406 is still required, so
    // this fallback cannot over-match on its own.
    expect(isDiffTooLargeError(octokitError(406, FILE_CAP_MESSAGE))).toBe(true);
  });

  test("does NOT match a 406 that is not a size refusal", () => {
    // The discriminating case, and the one Success Criterion 2 names: recognise
    // the status AND the code, not any 406. Absorbing an unrelated 406 would
    // convert a real failure into a silently degraded review.
    expect(isDiffTooLargeError(octokitError(406, "Not Acceptable"))).toBe(false);
  });

  test("does NOT match a non-406 that merely mentions too_large", () => {
    expect(isDiffTooLargeError(octokitError(500, FILE_CAP_MESSAGE, TOO_LARGE_ERRORS))).toBe(false);
    expect(isDiffTooLargeError(octokitError(403, "too_large"))).toBe(false);
  });

  test("does NOT match a 406 whose message only MENTIONS too_large (PR #3609 R1)", () => {
    // The fallback matches the serialized `"code":"too_large"` pair, not a bare
    // substring. A message that merely mentions the token — a quoted upstream
    // error, a PR title — must not route here, because a false positive
    // silently degrades a review that should have failed loudly.
    expect(isDiffTooLargeError(octokitError(406, "upstream said too_large, retrying"))).toBe(false);
  });

  test("does NOT match non-errors", () => {
    expect(isDiffTooLargeError(undefined)).toBe(false);
    expect(isDiffTooLargeError({ status: 406, message: "too_large" })).toBe(false);
  });
});

const MODIFIED: PrFileEntry = {
  filename: "src/alpha.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: "@@ -10,3 +10,4 @@ function alpha() {\n context\n-removed\n+added one\n+added two",
};

describe("reconstructDiff", () => {
  test("a modified file's added lines are anchorable by the REAL parser", () => {
    const { diff, filesWithPatch } = reconstructDiff([MODIFIED]);

    // Count first: an "output contains nothing bad" assertion over an empty
    // reconstruction is trivially true (mem#853).
    expect(filesWithPatch).toBe(1);

    const anchorable = parseRightSideAnchorableLines(diff);
    const lines = anchorable.get("src/alpha.ts");
    expect(lines).toBeDefined();
    // Hunk starts at new-line 10: context=10, +added one=11, +added two=12.
    // The removed line does not advance the new-side counter.
    expect([...(lines ?? [])].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  test("an added file uses /dev/null on the left and stays anchorable", () => {
    const { diff } = reconstructDiff([
      {
        filename: "src/new.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1,1 @@\n+brand new",
      },
    ]);

    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/src/new.ts");
    expect([...(parseRightSideAnchorableLines(diff).get("src/new.ts") ?? [])]).toEqual([1]);
  });

  test("a removed file yields NO right-side anchors", () => {
    // `+++ /dev/null` is how the parser learns there is no right side. Getting
    // this wrong would offer anchors on a deleted file and 422 the whole review.
    const { diff } = reconstructDiff([
      {
        filename: "src/gone.ts",
        status: "removed",
        additions: 0,
        deletions: 2,
        patch: "@@ -1,2 +0,0 @@\n-one\n-two",
      },
    ]);

    expect(diff).toContain("+++ /dev/null");
    expect(parseRightSideAnchorableLines(diff).get("src/gone.ts")).toBeUndefined();
  });

  test("a rename carries the OLD path on the left side", () => {
    const { diff } = reconstructDiff([
      {
        filename: "src/after.ts",
        status: "renamed",
        additions: 1,
        deletions: 0,
        previousFilename: "src/before.ts",
        patch: "@@ -1,1 +1,2 @@\n keep\n+extra",
      },
    ]);

    expect(diff).toContain("diff --git a/src/before.ts b/src/after.ts");
    expect(diff).toContain("--- a/src/before.ts");
    expect(diff).toContain("+++ b/src/after.ts");
  });

  test("a patch-less file is recorded, not dropped, and does not corrupt the next file", () => {
    // GitHub omits `patch` for binary files and files over its size cap
    // (mt#3018). Dropping them would leave the reviewer unable to distinguish
    // "unchanged" from "changed but withheld". The regression risk is that the
    // explanatory line derails parsing of everything after it — so the
    // assertion is that the FOLLOWING file still anchors correctly.
    const { diff, filesWithPatch, filesWithoutPatch } = reconstructDiff([
      { filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0 },
      MODIFIED,
    ]);

    expect(filesWithoutPatch).toEqual(["assets/logo.png"]);
    expect(filesWithPatch).toBe(1);

    const anchorable = parseRightSideAnchorableLines(diff);
    expect(anchorable.get("assets/logo.png")).toBeUndefined();
    expect([...(anchorable.get("src/alpha.ts") ?? [])].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  test("multiple files each anchor independently", () => {
    const { diff, filesWithPatch } = reconstructDiff([
      MODIFIED,
      {
        filename: "src/beta.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -5,1 +5,2 @@\n ctx\n+beta added",
      },
    ]);

    expect(filesWithPatch).toBe(2);
    const anchorable = parseRightSideAnchorableLines(diff);
    expect([...(anchorable.get("src/alpha.ts") ?? [])].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect([...(anchorable.get("src/beta.ts") ?? [])].sort((a, b) => a - b)).toEqual([5, 6]);
  });

  test("no entries yields an empty diff and a zero count", () => {
    // The caller keys its hard-failure on filesWithPatch === 0, so this is the
    // value that must be reported rather than an empty-but-successful diff.
    expect(reconstructDiff([])).toEqual({ diff: "", filesWithPatch: 0, filesWithoutPatch: [] });
  });
});
