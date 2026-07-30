import { describe, test, expect } from "bun:test";
import { parsePorcelainZPaths } from "./workspace-activity";

/**
 * Unit tests for `parsePorcelainZPaths` — the pure string-parsing core of
 * the workspace-mtime signal (mt#3193 PR #2307 R1 BLOCKING #1). The rest of
 * `workspace-activity.ts` spawns real `git`/`fs.stat` calls and is
 * exercised indirectly through `dispatch-recovery-classifier.test.ts` /
 * `dispatch-watchdog.test.ts`'s injected-fake `ActivitySources` — this file
 * covers the parsing logic that was the actual site of the bug: a rename or
 * deletion-only change set previously produced NO usable candidate paths at
 * all (see `resolveLastWorkspaceMtimeAtMs`'s docstring for the full
 * incident).
 */
describe("parsePorcelainZPaths", () => {
  test("returns an empty list for a clean tree (empty output)", () => {
    expect(parsePorcelainZPaths("")).toEqual([]);
  });

  test("parses a single modified file", () => {
    const output = " M src/foo.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/foo.ts"]);
  });

  test("parses a staged addition", () => {
    const output = "A  src/new-file.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/new-file.ts"]);
  });

  test("parses an untracked file", () => {
    const output = "?? src/untracked.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/untracked.ts"]);
  });

  test("parses a deleted file (the path is still returned — statSync failure is the caller's problem)", () => {
    const output = " D src/removed.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/removed.ts"]);
  });

  // The actual bug this test guards against: the OLD newline-based parser
  // returned the literal unparseable string "old/path -> new/path" for a
  // rename, which always failed `stat`. The `-z` format represents a rename
  // as the NEW path (in the same field as the R status) followed by a BARE
  // old-path field with no status prefix — this must resolve to the real,
  // stat-able NEW path, and the accompanying old-path field must be
  // consumed rather than misparsed as an unrelated entry.
  test("a rename entry yields the CURRENT (new) path, consuming the accompanying old-path field", () => {
    const output = "R  src/new-name.ts\0src/old-name.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/new-name.ts"]);
  });

  test("a copy entry (C) is handled the same way as a rename", () => {
    const output = "C  src/copy-dest.ts\0src/copy-src.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/copy-dest.ts"]);
  });

  test("a rename-only change set (the mt#3193 incident's worst case) still yields real paths, not empty", () => {
    const output =
      "R  src/module-a.ts\0src/original-2132-line-file.ts\0" +
      "R  src/module-b.ts\0src/scratch-old-name.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/module-a.ts", "src/module-b.ts"]);
  });

  test("a mix of modify, rename, delete, and untracked entries all resolve correctly", () => {
    const output =
      " M src/existing.ts\0" +
      "R  src/renamed-new.ts\0src/renamed-old.ts\0" +
      " D src/deleted.ts\0" +
      "?? src/brand-new.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual([
      "src/existing.ts",
      "src/renamed-new.ts",
      "src/deleted.ts",
      "src/brand-new.ts",
    ]);
  });

  test("a rename entry immediately followed by another entry does not swallow the next entry", () => {
    // Guards against an off-by-one in the "consume the next field" logic —
    // the entry AFTER the rename's old-path field must still be parsed.
    const output = "R  src/renamed.ts\0src/original.ts\0 M src/other-file.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/renamed.ts", "src/other-file.ts"]);
  });

  test("a path containing whitespace parses correctly under -z (the newline format's fragility)", () => {
    const output = " M src/file with spaces.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/file with spaces.ts"]);
  });

  test("ignores a malformed/too-short field rather than throwing", () => {
    const output = "XY\0 M src/real-file.ts\0";
    expect(parsePorcelainZPaths(output)).toEqual(["src/real-file.ts"]);
  });

  test("handles output with no trailing NUL gracefully (defensive — real git always trails with NUL)", () => {
    const output = " M src/foo.ts";
    expect(parsePorcelainZPaths(output)).toEqual(["src/foo.ts"]);
  });
});
