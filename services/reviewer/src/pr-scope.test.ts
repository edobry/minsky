/**
 * Tests for the PR scope classifier (mt#1188).
 *
 * Covers each scope rule, precedence order, the opt-out marker, and edge cases.
 */

import { describe, expect, test } from "bun:test";
import { classifyPRScope, scopeBucketFor, type PRScope } from "./pr-scope";

// Helper: build a minimal unified diff with N added lines.
function makeAddDiff(lines: number): string {
  const header = `--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,${lines + 1} @@\n`;
  return header + Array.from({ length: lines }, (_, i) => `+line${i + 1}`).join("\n");
}

// Trivial diff: 2 lines changed, 1 file.
const TRIVIAL_DIFF = makeAddDiff(2);
// Normal diff: 15 lines changed.
const NORMAL_DIFF = makeAddDiff(15);

describe("classifyPRScope — docs-only", () => {
  test("single README file is docs-only", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["README.md"] })).toBe("docs-only");
  });

  test("all .md files are docs-only", () => {
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["CHANGELOG.md", "docs/guide.md"],
      })
    ).toBe("docs-only");
  });

  test(".mdx file is docs-only", () => {
    expect(classifyPRScope({ diff: TRIVIAL_DIFF, filesChanged: ["docs/intro.mdx"] })).toBe(
      "docs-only"
    );
  });

  test("LICENSE file is docs-only", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["LICENSE"] })).toBe("docs-only");
  });

  test("docs/ subdirectory file is docs-only", () => {
    expect(
      classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["docs/architecture/adr-001.md"] })
    ).toBe("docs-only");
  });

  test("mixed docs and code is NOT docs-only", () => {
    const result = classifyPRScope({
      diff: NORMAL_DIFF,
      filesChanged: ["README.md", "src/foo.ts"],
    });
    expect(result).not.toBe("docs-only");
  });

  test("README without extension is docs-only", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["README"] })).toBe("docs-only");
  });
});

describe("classifyPRScope — test-only", () => {
  test("single .test.ts file is test-only", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["src/foo.test.ts"] })).toBe(
      "test-only"
    );
  });

  test(".spec.ts file is test-only", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["src/bar.spec.ts"] })).toBe(
      "test-only"
    );
  });

  test("tests/ directory file is test-only", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["tests/integration/foo.ts"] })).toBe(
      "test-only"
    );
  });

  test("multiple test files are test-only", () => {
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["src/a.test.ts", "src/b.spec.ts", "tests/setup.ts"],
      })
    ).toBe("test-only");
  });

  test("test + code file is NOT test-only", () => {
    const result = classifyPRScope({
      diff: NORMAL_DIFF,
      filesChanged: ["src/foo.test.ts", "src/foo.ts"],
    });
    expect(result).not.toBe("test-only");
  });

  test(".test.tsx file is test-only", () => {
    expect(
      classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["components/Button.test.tsx"] })
    ).toBe("test-only");
  });
});

describe("classifyPRScope — test-only (expanded TEST_FILE_PATTERN, mt#1188 BLOCKING 2)", () => {
  test("__tests__/ directory anywhere in path is test-only", () => {
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["src/__tests__/foo.ts", "src/__tests__/bar.ts"],
      })
    ).toBe("test-only");
  });

  test("nested __tests__/ (e.g. packages/core/__tests__/util.ts) is test-only", () => {
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["packages/core/__tests__/util.ts"],
      })
    ).toBe("test-only");
  });

  test("test/ at root (not nested) is test-only", () => {
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["test/integration/foo.ts"],
      })
    ).toBe("test-only");
  });

  test("case-insensitive: .TEST.ts extension is test-only", () => {
    // Unlikely in practice but the pattern now carries the i flag.
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["src/foo.TEST.ts"],
      })
    ).toBe("test-only");
  });

  test(".test.mjs file is test-only", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["scripts/util.test.mjs"] })).toBe(
      "test-only"
    );
  });

  test(".spec.cjs file is test-only", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["scripts/util.spec.cjs"] })).toBe(
      "test-only"
    );
  });

  test("__tests__/ file mixed with code file is NOT test-only", () => {
    const result = classifyPRScope({
      diff: NORMAL_DIFF,
      filesChanged: ["src/__tests__/foo.ts", "src/foo.ts"],
    });
    expect(result).not.toBe("test-only");
  });
});

describe("classifyPRScope — trivial", () => {
  test("2 changed lines, 1 file, non-docs/test → trivial", () => {
    expect(classifyPRScope({ diff: TRIVIAL_DIFF, filesChanged: ["src/foo.ts"] })).toBe("trivial");
  });

  test("9 changed lines, 2 files → trivial (boundary: <10 lines, <3 files)", () => {
    const diff = makeAddDiff(9);
    expect(classifyPRScope({ diff, filesChanged: ["src/a.ts", "src/b.ts"] })).toBe("trivial");
  });

  test("10 changed lines, 1 file → normal (boundary: not <10)", () => {
    const diff = makeAddDiff(10);
    expect(classifyPRScope({ diff, filesChanged: ["src/a.ts"] })).toBe("normal");
  });

  test("3 files, 2 changed lines → normal (boundary: not <3 files)", () => {
    expect(
      classifyPRScope({
        diff: TRIVIAL_DIFF,
        filesChanged: ["src/a.ts", "src/b.ts", "src/c.ts"],
      })
    ).toBe("normal");
  });
});

describe("classifyPRScope — normal", () => {
  test("large code change is normal", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["src/foo.ts", "src/bar.ts"] })).toBe(
      "normal"
    );
  });

  test("empty files list → normal (cannot classify reliably)", () => {
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: [] })).toBe("normal");
  });

  test("test + code mixed → normal", () => {
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["src/foo.ts", "src/foo.test.ts"],
      })
    ).toBe("normal");
  });
});

describe("classifyPRScope — precedence", () => {
  test("docs-only takes precedence over trivial (1-line README)", () => {
    // A 1-line README change satisfies both docs-only AND trivial criteria.
    // docs-only must win per the precedence rule.
    const diff = makeAddDiff(1);
    expect(classifyPRScope({ diff, filesChanged: ["README.md"] })).toBe("docs-only");
  });

  test("test-only takes precedence over trivial (small test change)", () => {
    const diff = makeAddDiff(3);
    expect(classifyPRScope({ diff, filesChanged: ["src/foo.test.ts"] })).toBe("test-only");
  });
});

describe("classifyPRScope — opt-out marker", () => {
  test("<!-- minsky:trivial --> in prBody forces trivial regardless of file list", () => {
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["src/foo.ts", "src/bar.ts", "src/baz.ts", "src/qux.ts"],
        prBody: "This is a minor fix.\n\n<!-- minsky:trivial -->",
      })
    ).toBe("trivial");
  });

  test("opt-out marker overrides docs-only too", () => {
    // Unusual edge case: a docs-only PR explicitly marked trivial. The marker
    // wins — downstream the scopeBucketFor mapping makes both equivalent, so
    // this is a no-op in practice, but the classifier must be consistent.
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["README.md"],
        prBody: "<!-- minsky:trivial -->",
      })
    ).toBe("trivial");
  });

  test("no prBody → marker check is skipped safely", () => {
    expect(classifyPRScope({ diff: TRIVIAL_DIFF, filesChanged: ["src/foo.ts"] })).toBe("trivial");
  });

  test("prBody without marker → normal classification applies", () => {
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["src/foo.ts", "src/bar.ts"],
        prBody: "Routine refactor. No special treatment needed.",
      })
    ).toBe("normal");
  });
});

describe("classifyPRScope — countChangedLines header anchoring (mt#1270)", () => {
  // Header anchoring: the previous startsWith("+++")/startsWith("---") check
  // skipped any added line whose payload itself started with `+++`/`---`
  // (Hugo frontmatter, fenced metadata, ASCII rules). Tightened anchoring on
  // `+++ a/`/`+++ b/`/`+++ /dev/null` (and `---` equivalents) means only real
  // file-header lines are skipped.

  test("frontmatter-style `++++` content lines (added with payload `+++`) are counted", () => {
    // Hugo frontmatter delimiter: an added line whose content is the literal
    // three-plus delimiter renders as `++++` in unified diff (marker `+` +
    // payload `+++`). Build a diff with 12 such lines on a single non-docs
    // file. Under old startsWith("+++") logic these would all be skipped →
    // count=0 → classified `trivial`. With anchored regex they are counted
    // → 12 ≥ 10 → classified `normal`. Sharp old-vs-new distinction.
    const header = "--- a/src/post.ts\n+++ b/src/post.ts\n@@ -1,1 +1,13 @@\n";
    const body = Array.from({ length: 12 }, () => "++++").join("\n");
    const diff = header + body;
    expect(classifyPRScope({ diff, filesChanged: ["src/post.ts"] })).toBe("normal");
  });

  test("`----` content lines (removed with payload `---`) are counted", () => {
    // Symmetric case for the removed side: a removed line whose content is
    // the literal three-dash delimiter renders as `----` (marker `-` + `---`).
    const header = "--- a/src/post.ts\n+++ b/src/post.ts\n@@ -1,13 +1,1 @@\n";
    const body = Array.from({ length: 12 }, () => "----").join("\n");
    const diff = header + body;
    expect(classifyPRScope({ diff, filesChanged: ["src/post.ts"] })).toBe("normal");
  });

  test("spec acceptance test diff: synthetic `+++ ---`/`+++data`/`---data` lines all counted", () => {
    // Exactly the diff from mt#1270's acceptance test:
    //   `+++ ---\n+content\n+++data\n-removed\n---data`
    // None of these are real file headers (line 1 lacks [ab]/|/dev/null;
    // lines 3 and 5 lack the trailing space). All 5 must count.
    //
    // Verification via the threshold: 5 lines on 1 file → trivial under both
    // old and new. To make the count observable, replicate the diff 3 times
    // (15 lines) — that crosses the trivial threshold (10) only if the
    // anchoring is correct. Under the old logic, only `+content` and
    // `-removed` count (2 per repetition), so 6 lines → still trivial.
    const repeated = Array(3).fill("+++ ---\n+content\n+++data\n-removed\n---data").join("\n");
    expect(classifyPRScope({ diff: repeated, filesChanged: ["src/foo.ts"] })).toBe("normal");
  });

  test("real file-header lines are still skipped (regression guard)", () => {
    // Two-file diff with proper `--- a/` and `+++ b/` headers plus 1 added
    // line in each. Total counted = 2 (just the `+x` payload lines), not 6
    // (would have included headers if anchoring broke).
    const diff =
      "--- a/file1.ts\n+++ b/file1.ts\n@@ -1,1 +1,2 @@\n+x\n" +
      "--- a/file2.ts\n+++ b/file2.ts\n@@ -1,1 +1,2 @@\n+y";
    // 2 changed lines, 2 files → trivial (boundary: <10 lines, <3 files).
    expect(classifyPRScope({ diff, filesChanged: ["file1.ts", "file2.ts"] })).toBe("trivial");
  });

  test("/dev/null header (new-file diff) is still skipped", () => {
    // New-file diff has `--- /dev/null` instead of `--- a/path`.
    const diff = "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+content";
    // 1 changed line, 1 file → trivial.
    expect(classifyPRScope({ diff, filesChanged: ["new.ts"] })).toBe("trivial");
  });
});

describe("classifyPRScope — pagination/truncation safeguard (mt#1270)", () => {
  // When the listFiles fetch returns fewer files than `pr.changed_files`, the
  // view is partial. A docs-only or test-only verdict on a truncated list
  // could mis-classify a PR whose later pages contain code. The classifier
  // must downgrade to `normal` regardless of the patterns in the partial view.

  test("filesChanged truncated below changedFilesCount → normal even when all visible files are docs", () => {
    // Hypothetical: 500 files changed but only 300 visible, all README.md-like.
    // Without the safeguard this would classify as `docs-only` → lower-rigor
    // prompt → reviewer might miss code findings on pages 4+.
    const filesChanged = Array.from({ length: 300 }, (_, i) => `docs/page-${i}.md`);
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged,
        changedFilesCount: 500,
      })
    ).toBe("normal");
  });

  test("filesChanged truncated below changedFilesCount → normal even when all visible files are tests", () => {
    const filesChanged = Array.from({ length: 300 }, (_, i) => `tests/spec-${i}.test.ts`);
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged,
        changedFilesCount: 1500,
      })
    ).toBe("normal");
  });

  test("filesChanged matches changedFilesCount → classifier proceeds normally (docs-only)", () => {
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["README.md", "CHANGELOG.md"],
        changedFilesCount: 2,
      })
    ).toBe("docs-only");
  });

  test("filesChanged length GREATER than changedFilesCount → classifier proceeds normally (count is not strict mismatch)", () => {
    // Defense-in-depth: if upstream returns more than the count claims (it
    // shouldn't, but APIs drift), do NOT downgrade. The safeguard is one-way:
    // truncation only.
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["README.md", "CHANGELOG.md", "docs/extra.md"],
        changedFilesCount: 2,
      })
    ).toBe("docs-only");
  });

  test("changedFilesCount omitted → classifier proceeds normally (back-compat)", () => {
    // Existing callers without the new field must keep working unchanged.
    expect(classifyPRScope({ diff: NORMAL_DIFF, filesChanged: ["README.md"] })).toBe("docs-only");
  });

  test("opt-out marker takes precedence over truncation safeguard", () => {
    // The user's explicit opt-out signal wins over the technical truncation
    // check — preserves the marker's role as the most authoritative input.
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: ["src/foo.ts"],
        changedFilesCount: 9999,
        prBody: "<!-- minsky:trivial -->",
      })
    ).toBe("trivial");
  });

  test("empty filesChanged with changedFilesCount > 0 → normal (existing empty-files path)", () => {
    // Already covered by the empty-files early return, but verifying the
    // truncation check doesn't break it.
    expect(
      classifyPRScope({
        diff: NORMAL_DIFF,
        filesChanged: [],
        changedFilesCount: 50,
      })
    ).toBe("normal");
  });
});

describe("scopeBucketFor", () => {
  const cases: Array<[PRScope, ReturnType<typeof scopeBucketFor>]> = [
    ["docs-only", "trivial-or-docs"],
    ["trivial", "trivial-or-docs"],
    ["test-only", "test-only"],
    ["normal", "normal"],
  ];

  for (const [scope, expected] of cases) {
    test(`${scope} → ${expected}`, () => {
      expect(scopeBucketFor(scope)).toBe(expected);
    });
  }
});
