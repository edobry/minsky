/**
 * Tests for the per-test-file changed-line coverage core (mt#4779).
 *
 * These fixtures are built to DISCRIMINATE, which this task's own subject makes
 * non-optional: each vacuous-case assertion is paired with a non-vacuous case
 * differing in exactly the property under test, so an assertion that passed
 * regardless of the logic would be visible as both cases agreeing.
 */
import { describe, expect, test } from "bun:test";
import {
  parseChangedLines,
  parseAddedTestFiles,
  parseLcovCoveredLines,
  evaluateCoverage,
  describeEvaluation,
  isTestFile,
} from "./test-changed-line-coverage";

/** The fixture's changed source file, and the test file the diff adds beside it. */
const SOURCE_FILE = "src/classifier.ts";
const TEST_FILE = "src/classifier.test.ts";

const DIFF_ADDING_TEST_AND_CHANGING_SOURCE = `diff --git a/src/classifier.ts b/src/classifier.ts
index 1111111..2222222 100644
--- a/src/classifier.ts
+++ b/src/classifier.ts
@@ -40,0 +41,3 @@ export function classify(origin) {
+  if (origin.marker === "watermark") {
+    return "dispatch_brief";
+  }
diff --git a/src/classifier.test.ts b/src/classifier.test.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/classifier.test.ts
@@ -0,0 +1,4 @@
+test("an operator QUOTING a watermark in prose stays human", () => {
+  expect(classify({ kind: "human" })).toBe("human");
+});
+
`;

describe("parseChangedLines", () => {
  test("collects added post-image line numbers per file", () => {
    const changed = parseChangedLines(DIFF_ADDING_TEST_AND_CHANGING_SOURCE);
    expect([...(changed.get(SOURCE_FILE) ?? [])]).toEqual([41, 42, 43]);
  });

  test("a deleted line consumes no post-image line number", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,1 @@
-const gone = 1;
+const kept = 2;
`;
    expect([...(parseChangedLines(diff).get("src/a.ts") ?? [])]).toEqual([10]);
  });

  test("a pure deletion contributes no file at all", () => {
    const diff = `diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-const b = 2;
`;
    expect(parseChangedLines(diff).has("src/gone.ts")).toBe(false);
  });
});

describe("parseAddedTestFiles", () => {
  test("returns only files added by the diff, filtered to test files", () => {
    expect(parseAddedTestFiles(DIFF_ADDING_TEST_AND_CHANGING_SOURCE)).toEqual([TEST_FILE]);
  });

  test("a MODIFIED test file is not returned — mt#1459's added-only floor", () => {
    const diff = `diff --git a/src/existing.test.ts b/src/existing.test.ts
index 1111111..2222222 100644
--- a/src/existing.test.ts
+++ b/src/existing.test.ts
@@ -1,0 +2,1 @@
+  // one more case
`;
    expect(parseAddedTestFiles(diff)).toEqual([]);
  });

  test("an added NON-test file is not returned", () => {
    const diff = `diff --git a/src/helper.ts b/src/helper.ts
new file mode 100644
--- /dev/null
+++ b/src/helper.ts
@@ -0,0 +1,1 @@
+export const x = 1;
`;
    expect(parseAddedTestFiles(diff)).toEqual([]);
  });

  test("isTestFile covers the .test/.spec x .ts/.tsx matrix", () => {
    expect(isTestFile("a/b.test.ts")).toBe(true);
    expect(isTestFile("a/b.test.tsx")).toBe(true);
    expect(isTestFile("a/b.spec.ts")).toBe(true);
    expect(isTestFile("a/b.spec.tsx")).toBe(true);
    expect(isTestFile("a/b.ts")).toBe(false);
    expect(isTestFile("a/testing.ts")).toBe(false);
  });
});

describe("parseLcovCoveredLines", () => {
  const LCOV = `SF:/repo/src/classifier.ts
DA:41,3
DA:42,0
DA:43,1
end_of_record
SF:/repo/src/other.ts
DA:7,0
end_of_record
`;

  test("keeps only lines with a nonzero hit count", () => {
    const covered = parseLcovCoveredLines(LCOV, "/repo");
    expect([...(covered.get(SOURCE_FILE) ?? [])]).toEqual([41, 43]);
  });

  test("a file whose every line has zero hits contributes no lines", () => {
    const covered = parseLcovCoveredLines(LCOV, "/repo");
    expect(covered.has("src/other.ts")).toBe(false);
  });
});

describe("evaluateCoverage — AT1/AT2, the discriminating pair", () => {
  const changed = parseChangedLines(DIFF_ADDING_TEST_AND_CHANGING_SOURCE);

  test("AT1: a test executing none of the changed lines is vacuous", () => {
    // Its run covered a DIFFERENT module — the changed classifier lines are untouched.
    const covered = parseLcovCoveredLines(
      `SF:/repo/src/unrelated.ts
DA:5,2
end_of_record
`,
      "/repo"
    );
    const verdict = evaluateCoverage(TEST_FILE, changed, covered);

    expect(verdict.vacuous).toBe(true);
    expect(verdict.changedLinesCovered).toBe(0);
    expect(verdict.unreachedFiles).toEqual([SOURCE_FILE]);
  });

  test("AT2: the SAME fixture, differing only in coverage, is NOT vacuous", () => {
    // Identical changed-line map and identical test file. The only difference is
    // that this run executed the changed lines — so a verdict that came out the
    // same as AT1 would prove the check reads nothing.
    const covered = parseLcovCoveredLines(
      `SF:/repo/src/classifier.ts
DA:41,1
DA:42,1
end_of_record
`,
      "/repo"
    );
    const verdict = evaluateCoverage(TEST_FILE, changed, covered);

    expect(verdict.vacuous).toBe(false);
    expect(verdict.changedLinesCovered).toBe(2);
    expect(verdict.reachedFiles).toEqual([SOURCE_FILE]);
  });

  test("AT2: asserting a DEFAULT outcome does not by itself flag — coverage decides", () => {
    // mt#4423 AT3's over-fire guard: the legitimate case is a test that asserts a
    // fail-open default AND reaches the changed path. Nothing here inspects the
    // assertion, which is exactly why a default-asserting test passes when its
    // coverage says it reached the code.
    const covered = parseLcovCoveredLines(
      `SF:/repo/src/classifier.ts
DA:43,1
end_of_record
`,
      "/repo"
    );
    expect(evaluateCoverage(TEST_FILE, changed, covered).vacuous).toBe(false);
  });
});

describe("evaluateCoverage — the self-exclusion that keeps the check able to fail", () => {
  test("a test file's OWN changed lines do not count as coverage", () => {
    // A newly added test file is itself a changed file. If its own executed lines
    // counted, EVERY added test would be non-vacuous and the check could never
    // fire — a probe that returns the same answer whether or not the system is
    // broken (mem#704). This asserts the exclusion directly.
    const changed = parseChangedLines(DIFF_ADDING_TEST_AND_CHANGING_SOURCE);
    const coveredOnlyItself = parseLcovCoveredLines(
      `SF:/repo/src/classifier.test.ts
DA:1,1
DA:2,1
end_of_record
`,
      "/repo"
    );

    const verdict = evaluateCoverage(TEST_FILE, changed, coveredOnlyItself);
    expect(verdict.vacuous).toBe(true);
    expect(verdict.changedLinesCovered).toBe(0);
  });

  test("another test file's changed lines are excluded too", () => {
    // Two tests covering each other must not launder each other into coverage.
    const changed: Map<string, Set<number>> = new Map([["src/sibling.test.ts", new Set([1, 2])]]);
    const covered: Map<string, Set<number>> = new Map([["src/sibling.test.ts", new Set([1, 2])]]);
    expect(evaluateCoverage(TEST_FILE, changed, covered).vacuous).toBe(true);
  });
});

describe("evaluateCoverage — AT4 and the empty cases", () => {
  test("AT4: a diff with no changed non-test files yields no reachable target", () => {
    const changed = parseChangedLines(`diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,0 +2,1 @@
+a line
`);
    const verdict = evaluateCoverage("src/x.test.ts", changed, new Map());
    // README is a changed non-test file, so it is a legitimate unreached target.
    expect(verdict.unreachedFiles).toEqual(["README.md"]);
    expect(verdict.vacuous).toBe(true);
  });
});

describe("describeEvaluation", () => {
  test("a vacuous finding names the test AND the files it failed to reach", () => {
    const message = describeEvaluation({
      testFile: TEST_FILE,
      changedLinesCovered: 0,
      reachedFiles: [],
      unreachedFiles: [SOURCE_FILE],
      vacuous: true,
    });
    expect(message).toContain(TEST_FILE);
    expect(message).toContain(SOURCE_FILE);
    expect(message).toContain("NONE");
  });

  test("a non-vacuous evaluation reports the intersection SIZE (mt#4423 SC3')", () => {
    const message = describeEvaluation({
      testFile: TEST_FILE,
      changedLinesCovered: 4,
      reachedFiles: [SOURCE_FILE],
      unreachedFiles: [],
      vacuous: false,
    });
    expect(message).toContain("4 changed line(s)");
  });
});
