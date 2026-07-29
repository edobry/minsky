import { describe, test, expect } from "bun:test";
import {
  detectMarkdownDuplicateBlocks,
  detectJsonDuplicateEntries,
  detectDuplicateGeneratedContent,
  filterStagedWatchedFiles,
  isDuplicateGeneratedContentOverrideTruthy,
  DUPLICATE_GENERATED_CONTENT_CHECK_OVERRIDE_ENV,
  WATCHED_GENERATED_FILES,
} from "./duplicate-generated-content-detector";

const MD_FILE = "CLAUDE.md";
const JSON_FILE = "src/generated/completion-manifest.json";

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
    const lines = WATCHED_GENERATED_FILES.map((f) => `M\t${f}`);
    expect(filterStagedWatchedFiles(lines)).toEqual(WATCHED_GENERATED_FILES as string[]);
  });

  test("matches files under the watched skills directory", () => {
    const lines = ["A\t.claude/skills/implement-task/skill.md"];
    expect(filterStagedWatchedFiles(lines)).toEqual([".claude/skills/implement-task/skill.md"]);
  });

  test("ignores unrelated staged files", () => {
    expect(filterStagedWatchedFiles(["M\tsrc/domain/foo.ts"])).toHaveLength(0);
  });

  test("handles rename status lines (uses the new path)", () => {
    expect(filterStagedWatchedFiles(["R100\told-name.md\tCLAUDE.md"])).toEqual(["CLAUDE.md"]);
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
