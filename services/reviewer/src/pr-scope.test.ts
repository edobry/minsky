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
