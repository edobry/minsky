/**
 * Tests for the markdown-strip / truncation snippet helper (mt#2770).
 */
import { describe, expect, test } from "bun:test";
import {
  stripMarkdown,
  truncateSnippet,
  toDisplaySnippet,
  stripHarnessMarkup,
} from "./text-snippet";

describe("stripMarkdown", () => {
  test("strips code fences", () => {
    expect(stripMarkdown("before ```code block\nmore code``` after")).toBe("before after");
  });

  test("unwraps inline code", () => {
    expect(stripMarkdown("run `bun test` now")).toBe("run bun test now");
  });

  test("unwraps links to their text", () => {
    expect(stripMarkdown("see [the docs](https://example.com) for more")).toBe(
      "see the docs for more"
    );
  });

  test("unwraps images to alt text", () => {
    expect(stripMarkdown("![a diagram](https://example.com/x.png) shown above")).toBe(
      "a diagram shown above"
    );
  });

  test("strips heading markers", () => {
    expect(stripMarkdown("# Fix the bug\nmore context")).toBe("Fix the bug more context");
  });

  test("strips list and blockquote markers", () => {
    expect(stripMarkdown("- first\n- second\n> quoted")).toBe("first second quoted");
  });

  test("strips bold/italic emphasis", () => {
    expect(stripMarkdown("this is **bold** and _italic_ and ***both***")).toBe(
      "this is bold and italic and both"
    );
  });

  test("collapses newlines and repeated whitespace", () => {
    expect(stripMarkdown("line one\n\nline   two")).toBe("line one line two");
  });
});

describe("stripHarnessMarkup", () => {
  test("drops a command-message block entirely (tag + contents)", () => {
    expect(stripHarnessMarkup("<command-message>error-handling</command-message>")).toBe(" ");
  });

  test("drops a command-name block entirely (tag + contents)", () => {
    expect(stripHarnessMarkup("<command-name>implement-task</command-name>")).toBe(" ");
  });

  test("drops a local-command-stdout block entirely (tag + contents)", () => {
    expect(
      stripHarnessMarkup("<local-command-stdout>some tool output here</local-command-stdout>")
    ).toBe(" ");
  });

  test("drops a system-reminder block entirely (tag + contents)", () => {
    expect(
      stripHarnessMarkup("<system-reminder>internal context injection</system-reminder>")
    ).toBe(" ");
  });

  test("preserves surrounding operator prose around a stripped block", () => {
    const input =
      "<command-message>error-handling</command-message>\nplease also check the retry logic";
    expect(stripHarnessMarkup(input)).toBe(" \nplease also check the retry logic");
  });

  test("leaves plain prose with no harness tags unchanged", () => {
    expect(stripHarnessMarkup("just a normal user message")).toBe("just a normal user message");
  });
});

describe("truncateSnippet", () => {
  test("returns text unchanged when within maxLen", () => {
    expect(truncateSnippet("short text", 60)).toBe("short text");
  });

  test("truncates at a word boundary with ellipsis", () => {
    const long = "the quick brown fox jumps over the lazy dog and keeps running";
    const result = truncateSnippet(long, 30);
    expect(result.length).toBeLessThanOrEqual(31); // 30 + ellipsis char
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("  ");
  });

  test("hard-cuts when no reasonable word boundary exists", () => {
    const long = "a".repeat(100);
    const result = truncateSnippet(long, 20);
    expect(result).toBe(`${"a".repeat(20)}…`);
  });
});

describe("toDisplaySnippet", () => {
  test("returns empty string for null/undefined/empty input", () => {
    expect(toDisplaySnippet(null, 60)).toBe("");
    expect(toDisplaySnippet(undefined, 60)).toBe("");
    expect(toDisplaySnippet("", 60)).toBe("");
  });

  test("strips markdown then truncates in one pass", () => {
    const input =
      "# Implement mt#2770\n\nDerive human-readable labels for conversations so run-list rows stop reading as raw timestamps.";
    const result = toDisplaySnippet(input, 60);
    expect(result.length).toBeLessThanOrEqual(61);
    // The leading heading marker is stripped; a legitimate `#` inside the
    // text (as in a task id like "mt#2770") is preserved, not stripped.
    expect(result.startsWith("#")).toBe(false);
    expect(result.startsWith("Implement mt#2770")).toBe(true);
  });

  test("returns stripped text unchanged when shorter than maxLen", () => {
    expect(toDisplaySnippet("`fix` the bug", 60)).toBe("fix the bug");
  });

  test("returns empty string when the whole input is a command-message block (mt#2784)", () => {
    expect(toDisplaySnippet("<command-message>error-handling</command-message>", 60)).toBe("");
  });

  test("mixed markup + text: strips the wrapper block, keeps the real prose (mt#2784)", () => {
    const input =
      "<command-message>implement-task</command-message>\nplease also verify the retry path";
    expect(toDisplaySnippet(input, 60)).toBe("please also verify the retry path");
  });

  test("system-reminder-prefixed prompt: strips the reminder, keeps the operator's question (mt#2784)", () => {
    const input =
      "<system-reminder>Background context injected by the harness.</system-reminder>\nWhy does the reviewer bot keep timing out?";
    expect(toDisplaySnippet(input, 60)).toBe("Why does the reviewer bot keep timing out?");
  });
});
