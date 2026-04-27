import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff, type DiffFile, type DiffHunk, type DiffLine } from "./parse-diff";

const NEW_FILE_MODE = "new file mode 100644";
const FILE_INDEX = "index abc1234..def5678 100644";
const FILE_DIFF_HEADER = "diff --git a/file.ts b/file.ts";

function firstFile(diff: string): DiffFile {
  const result = parseUnifiedDiff(diff);
  expect(result.length).toBeGreaterThanOrEqual(1);
  const file = result[0];
  if (!file) throw new Error("expected at least one file");
  return file;
}

function firstHunk(file: DiffFile): DiffHunk {
  expect(file.hunks.length).toBeGreaterThanOrEqual(1);
  const hunk = file.hunks[0];
  if (!hunk) throw new Error("expected at least one hunk");
  return hunk;
}

function findLine(hunk: DiffHunk, content: string): DiffLine {
  const line = hunk.lines.find((l) => l.content === content);
  if (!line) throw new Error(`expected to find a line with content "${content}"`);
  return line;
}

describe("parseUnifiedDiff", () => {
  test("parses a pure-add file", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      NEW_FILE_MODE,
      "index 0000000..abc1234",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,3 @@",
      "+export const a = 1;",
      "+export const b = 2;",
      "+export const c = 3;",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file).toMatchObject({ path: "new.ts", status: "added" });

    const hunk = firstHunk(file);
    expect(hunk.oldStart).toBe(0);
    expect(hunk.oldLines).toBe(0);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(3);
    expect(hunk.lines).toHaveLength(3);
    expect(hunk.lines[0]).toEqual({
      side: "RIGHT",
      oldLine: null,
      newLine: 1,
      content: "export const a = 1;",
    });
    expect(hunk.lines[2]).toEqual({
      side: "RIGHT",
      oldLine: null,
      newLine: 3,
      content: "export const c = 3;",
    });
  });

  test("parses a pure-delete file", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "index abc1234..0000000",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-export const x = 1;",
      "-export const y = 2;",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file).toMatchObject({ path: "gone.ts", status: "deleted" });

    const hunk = firstHunk(file);
    expect(hunk.lines).toHaveLength(2);
    expect(hunk.lines[0]).toEqual({
      side: "LEFT",
      oldLine: 1,
      newLine: null,
      content: "export const x = 1;",
    });
    expect(hunk.lines[1]).toEqual({
      side: "LEFT",
      oldLine: 2,
      newLine: null,
      content: "export const y = 2;",
    });
  });

  test("parses a modified file with multiple hunks", () => {
    const diff = [
      FILE_DIFF_HEADER,
      FILE_INDEX,
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,4 @@",
      " line a",
      "-line b",
      "+line b modified",
      "+line b extra",
      " line c",
      "@@ -10,2 +11,3 @@",
      " line j",
      "+line j2",
      " line k",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file).toMatchObject({ path: "file.ts", status: "modified" });
    expect(file.hunks).toHaveLength(2);

    const [h1, h2] = file.hunks;
    if (!h1 || !h2) throw new Error("expected two hunks");

    expect(h1.oldStart).toBe(1);
    expect(h1.oldLines).toBe(3);
    expect(h1.newStart).toBe(1);
    expect(h1.newLines).toBe(4);

    expect(findLine(h1, "line b")).toEqual({
      side: "LEFT",
      oldLine: 2,
      newLine: null,
      content: "line b",
    });
    expect(findLine(h1, "line b modified")).toEqual({
      side: "RIGHT",
      oldLine: null,
      newLine: 2,
      content: "line b modified",
    });
    expect(findLine(h1, "line b extra")).toEqual({
      side: "RIGHT",
      oldLine: null,
      newLine: 3,
      content: "line b extra",
    });
    expect(findLine(h1, "line c")).toEqual({
      side: "CONTEXT",
      oldLine: 3,
      newLine: 4,
      content: "line c",
    });

    expect(h2.oldStart).toBe(10);
    expect(h2.newStart).toBe(11);
    expect(findLine(h2, "line j2")).toEqual({
      side: "RIGHT",
      oldLine: null,
      newLine: 12,
      content: "line j2",
    });
  });

  test("parses a rename without content change (no hunks)", () => {
    const diff = [
      "diff --git a/old/path.ts b/new/path.ts",
      "similarity index 100%",
      "rename from old/path.ts",
      "rename to new/path.ts",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file).toMatchObject({
      path: "new/path.ts",
      oldPath: "old/path.ts",
      status: "renamed",
    });
    expect(file.hunks).toHaveLength(0);
  });

  test("parses a rename with content change (has hunks)", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 80%",
      "rename from old.ts",
      "rename to new.ts",
      "index abc1234..def5678 100644",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,2 +1,2 @@",
      " kept",
      "-removed",
      "+added",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file).toMatchObject({
      path: "new.ts",
      oldPath: "old.ts",
      status: "renamed",
    });

    const hunk = firstHunk(file);
    expect(hunk.lines.map((l) => l.content)).toEqual(["kept", "removed", "added"]);
  });

  test("ignores no-newline-at-end-of-file marker without counting it as a line", () => {
    const diff = [
      FILE_DIFF_HEADER,
      FILE_INDEX,
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,2 +1,2 @@",
      " line a",
      "-line b",
      "\\ No newline at end of file",
      "+line b changed",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const file = firstFile(diff);
    const hunk = firstHunk(file);
    expect(hunk.lines).toHaveLength(3);
    expect(hunk.lines.map((l) => l.content)).toEqual(["line a", "line b", "line b changed"]);
  });

  test("parses multiple files in a single diff", () => {
    const diff = [
      "diff --git a/one.ts b/one.ts",
      NEW_FILE_MODE,
      "--- /dev/null",
      "+++ b/one.ts",
      "@@ -0,0 +1,1 @@",
      "+a",
      "diff --git a/two.ts b/two.ts",
      NEW_FILE_MODE,
      "--- /dev/null",
      "+++ b/two.ts",
      "@@ -0,0 +1,1 @@",
      "+b",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(diff);
    expect(result.map((f) => f.path)).toEqual(["one.ts", "two.ts"]);
    expect(result.map((f) => f.status)).toEqual(["added", "added"]);
  });

  test("returns empty array on empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  test("infers path from diff --git header for mode-only changes (no ---/+++)", () => {
    // git emits this shape when only the file mode changes — no content diff.
    const diff = [
      "diff --git a/scripts/run.sh b/scripts/run.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file.path).toBe("scripts/run.sh");
    expect(file.status).toBe("modified");
    expect(file.hunks).toHaveLength(0);
  });

  test("handles binary-files-differ markers and recovers the path", () => {
    const diff = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      FILE_INDEX,
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file.path).toBe("assets/logo.png");
    expect(file.status).toBe("modified");
    expect(file.hunks).toHaveLength(0);
  });

  test("handles GIT binary patch markers and recovers the path", () => {
    const diff = [
      "diff --git a/data.bin b/data.bin",
      FILE_INDEX,
      "GIT binary patch",
      "delta 42",
      "zcmZpZ4i#deletedeltadata",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file.path).toBe("data.bin");
    expect(file.status).toBe("modified");
    expect(file.hunks).toHaveLength(0);
  });

  test("classifies empty-file add via 'new file mode' header (no ---/+++)", () => {
    // git emits this shape when an empty file is created.
    const diff = [
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file.path).toBe("empty.txt");
    expect(file.status).toBe("added");
    expect(file.hunks).toHaveLength(0);
  });

  test("splits diff --git correctly when path contains literal ' b/' substring (symmetric)", () => {
    // Reviewer-bot finding on PR #835 round-3: the naive regex
    // /^diff --git a\/(.+?) b\/(.+)$/ would stop at the first ' b/' it sees,
    // mis-assigning the rest to the new-side. The symmetric-split fast path
    // recovers the correct delimiter when both sides match.
    const diff = [
      "diff --git a/foo b/dir/file.txt b/foo b/dir/file.txt",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file.path).toBe("foo b/dir/file.txt");
    expect(file.status).toBe("modified");
    expect(file.hunks).toHaveLength(0);
  });

  test("classifies empty-file delete via 'deleted file mode' header (no ---/+++)", () => {
    // git emits this shape when an empty file is deleted.
    const diff = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index e69de29..0000000",
      "",
    ].join("\n");

    const file = firstFile(diff);
    expect(file.path).toBe("gone.txt");
    expect(file.status).toBe("deleted");
    expect(file.hunks).toHaveLength(0);
  });

  test("emitted (path, line, side) tuples are valid GitHub createReview anchors", () => {
    // Round-trip property: every line emitted must satisfy the bounds GitHub
    // enforces on octokit.rest.pulls.createReview comments[] anchors.
    const diff = [
      FILE_DIFF_HEADER,
      FILE_INDEX,
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -5,4 +10,5 @@",
      " context_a",
      "-removed_b",
      "+added_b",
      "+added_b2",
      " context_c",
      "",
    ].join("\n");

    const hunk = firstHunk(firstFile(diff));

    for (const line of hunk.lines) {
      if (line.side === "RIGHT") {
        expect(line.newLine).not.toBeNull();
        expect(line.oldLine).toBeNull();
        const newLine = line.newLine ?? -1;
        expect(newLine).toBeGreaterThanOrEqual(hunk.newStart);
        expect(newLine).toBeLessThanOrEqual(hunk.newStart + hunk.newLines - 1);
      } else if (line.side === "LEFT") {
        expect(line.oldLine).not.toBeNull();
        expect(line.newLine).toBeNull();
        const oldLine = line.oldLine ?? -1;
        expect(oldLine).toBeGreaterThanOrEqual(hunk.oldStart);
        expect(oldLine).toBeLessThanOrEqual(hunk.oldStart + hunk.oldLines - 1);
      } else {
        expect(line.oldLine).not.toBeNull();
        expect(line.newLine).not.toBeNull();
      }
    }
  });
});
