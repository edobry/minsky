import { describe, test, expect } from "bun:test";
import {
  detectMarkdownDuplicateBlocks,
  detectJsonDuplicateEntries,
  detectDuplicateGeneratedContent,
  filterStagedWatchedFiles,
  parseNameStatusZ,
  isDuplicateGeneratedContentOverrideTruthy,
  DUPLICATE_GENERATED_CONTENT_CHECK_OVERRIDE_ENV,
  WATCHED_GENERATED_FILES,
} from "./duplicate-generated-content-detector";

const MD_FILE = "CLAUDE.md";
const JSON_FILE = "src/generated/completion-manifest.json";

// Reused across the heading-level-noise test pair below.
const SHARED_BODY_LINES = [
  "shared line one",
  "shared line two",
  "shared line three",
  "shared line four",
];

describe("detectMarkdownDuplicateBlocks", () => {
  test("flags two headings with byte-identical bodies", () => {
    const content = [
      "## Section One",
      "line one of body",
      "line two of body",
      "line three of body",
      "line four of body",
      "",
      "## Section Two",
      "line one of body",
      "line two of body",
      "line three of body",
      "line four of body",
    ].join("\n");
    const violations = detectMarkdownDuplicateBlocks(MD_FILE, content);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      filePath: MD_FILE,
      firstLabel: "Section One",
      duplicateLabel: "Section Two",
      kind: "markdown-heading-block",
    });
  });

  test("does not flag distinct section bodies", () => {
    const content = [
      "## One",
      "alpha",
      "beta",
      "gamma",
      "delta",
      "## Two",
      "different",
      "content",
      "here",
      "entirely",
    ].join("\n");
    expect(detectMarkdownDuplicateBlocks(MD_FILE, content)).toHaveLength(0);
  });

  test("skips trivially short duplicate blocks", () => {
    const content = ["## One", "short", "## Two", "short"].join("\n");
    expect(detectMarkdownDuplicateBlocks(MD_FILE, content)).toHaveLength(0);
  });

  test("handles content with no headings", () => {
    expect(
      detectMarkdownDuplicateBlocks(MD_FILE, "just plain text\nno headings here")
    ).toHaveLength(0);
  });

  test("does not flag identical bodies at DIFFERENT heading levels (mt#3299 PR #2392 R1 non-blocking: heading-level noise)", () => {
    const content = [
      "# Top Section",
      ...SHARED_BODY_LINES,
      "## Sub Section",
      ...SHARED_BODY_LINES,
    ].join("\n");
    // A level-1 block and a level-2 block with byte-identical bodies must
    // NOT be flagged — they sit at different structural depths, not the
    // same repeated section.
    expect(detectMarkdownDuplicateBlocks(MD_FILE, content)).toHaveLength(0);
  });

  test("still flags identical bodies at the SAME heading level", () => {
    const content = [
      "## Section One",
      ...SHARED_BODY_LINES,
      "## Section Two",
      ...SHARED_BODY_LINES,
    ].join("\n");
    expect(detectMarkdownDuplicateBlocks(MD_FILE, content)).toHaveLength(1);
  });
});

describe("detectJsonDuplicateEntries", () => {
  test("flags two top-level keys with identical serialized values", () => {
    const bigValue = { description: "a fairly long description string that exceeds the threshold" };
    const content = JSON.stringify({ skillOne: bigValue, skillTwo: bigValue });
    const violations = detectJsonDuplicateEntries(JSON_FILE, content);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      filePath: JSON_FILE,
      firstLabel: "skillOne",
      duplicateLabel: "skillTwo",
      kind: "json-top-level-entry",
    });
  });

  test("does not flag distinct values", () => {
    const content = JSON.stringify({
      a: { description: "a fairly long description string number one here" },
      b: { description: "a fairly different description string number two" },
    });
    expect(detectJsonDuplicateEntries(JSON_FILE, content)).toHaveLength(0);
  });

  test("skips unparseable content", () => {
    expect(detectJsonDuplicateEntries(JSON_FILE, "not json{{{")).toHaveLength(0);
  });

  test("skips array-root JSON", () => {
    expect(detectJsonDuplicateEntries(JSON_FILE, "[1,2,3]")).toHaveLength(0);
  });
});

describe("detectDuplicateGeneratedContent dispatch", () => {
  test("routes .json files to the JSON detector", () => {
    const bigValue = { d: "a fairly long description string that exceeds the threshold" };
    const content = JSON.stringify({ a: bigValue, b: bigValue });
    expect(detectDuplicateGeneratedContent(JSON_FILE, content)).toHaveLength(1);
  });

  test("routes .md files to the markdown detector", () => {
    const content = [
      "## A",
      "one",
      "two",
      "three",
      "four",
      "## B",
      "one",
      "two",
      "three",
      "four",
    ].join("\n");
    expect(detectDuplicateGeneratedContent(MD_FILE, content)).toHaveLength(1);
  });

  test("returns empty for unrecognized extensions", () => {
    expect(detectDuplicateGeneratedContent("some-file.txt", "anything")).toHaveLength(0);
  });
});

describe("filterStagedWatchedFiles", () => {
  test("matches exact watched files", () => {
    const records = WATCHED_GENERATED_FILES.map((f) => ["M", f]);
    expect(filterStagedWatchedFiles(records)).toEqual(WATCHED_GENERATED_FILES as string[]);
  });

  test("matches files under the watched skills directory", () => {
    const records = [["A", ".claude/skills/implement-task/skill.md"]];
    expect(filterStagedWatchedFiles(records)).toEqual([".claude/skills/implement-task/skill.md"]);
  });

  test("ignores unrelated staged files", () => {
    expect(filterStagedWatchedFiles([["M", "src/domain/foo.ts"]])).toHaveLength(0);
  });

  test("handles rename records (uses the new path)", () => {
    expect(filterStagedWatchedFiles([["R100", "old-name.md", "CLAUDE.md"]])).toEqual(["CLAUDE.md"]);
  });
});

/** Build NUL-delimited `git diff --name-status -z` style output from tokens. */
function nulRecord(...tokens: string[]): string {
  return `${tokens.join("\0")}\0`;
}

describe("parseNameStatusZ", () => {
  test("parses plain add/modify records", () => {
    const output = nulRecord("M", "CLAUDE.md", "A", "AGENTS.md");
    expect(parseNameStatusZ(output)).toEqual([
      ["M", "CLAUDE.md"],
      ["A", "AGENTS.md"],
    ]);
  });

  test("parses rename/copy records as 3-token entries", () => {
    const output = nulRecord("R100", "old-name.md", "CLAUDE.md");
    expect(parseNameStatusZ(output)).toEqual([["R100", "old-name.md", "CLAUDE.md"]]);
  });

  test("handles a path containing a space without corruption", () => {
    // The whole point of NUL-delimited parsing: a space inside a path is
    // just a normal character in its token, not a field/record separator.
    const output = nulRecord("M", "docs/a file with spaces.md");
    expect(parseNameStatusZ(output)).toEqual([["M", "docs/a file with spaces.md"]]);
  });

  test("handles empty output", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });

  test("parses a mix of plain and rename records", () => {
    const output = nulRecord("M", "CLAUDE.md", "R095", "old.md", "new.md", "A", "AGENTS.md");
    expect(parseNameStatusZ(output)).toEqual([
      ["M", "CLAUDE.md"],
      ["R095", "old.md", "new.md"],
      ["A", "AGENTS.md"],
    ]);
  });
});

describe("isDuplicateGeneratedContentOverrideTruthy", () => {
  test("recognizes truthy values", () => {
    expect(isDuplicateGeneratedContentOverrideTruthy("1")).toBe(true);
    expect(isDuplicateGeneratedContentOverrideTruthy("true")).toBe(true);
  });

  test("rejects falsy/undefined values", () => {
    expect(isDuplicateGeneratedContentOverrideTruthy(undefined)).toBe(false);
    expect(isDuplicateGeneratedContentOverrideTruthy("0")).toBe(false);
  });

  test("exports the expected override env-var name", () => {
    expect(DUPLICATE_GENERATED_CONTENT_CHECK_OVERRIDE_ENV).toBe(
      "MINSKY_SKIP_DUPLICATE_GENERATED_CONTENT_CHECK"
    );
  });
});
