/**
 * Tests for the per-tool summary registry (mt#2790).
 */
import { describe, test, expect } from "bun:test";
import { summarizeToolInvocation, genericOutcomeDigest } from "./tool-summary";

describe("summarizeToolInvocation — seeded tools", () => {
  test("Bash shows the truncated command, not JSON", () => {
    const digest = summarizeToolInvocation(
      "Bash",
      { command: "git log --oneline -n 20" },
      { content: "abc123 fix\ndef456 feat\n", isError: false }
    );
    expect(digest).toContain("git log --oneline -n 20");
    expect(digest).not.toContain("{");
    expect(digest).toContain("→");
  });

  test("session_exec (harness-native alias) also shows the command", () => {
    const digest = summarizeToolInvocation("session_exec", { command: "bun test" }, undefined);
    expect(digest).toContain("bun test");
    expect(digest).toContain("pending");
  });

  test("Read shows the file path", () => {
    const digest = summarizeToolInvocation(
      "Read",
      { file_path: "/repo/src/index.ts" },
      { content: "line one\nline two", isError: false }
    );
    expect(digest).toContain("/repo/src/index.ts");
    expect(digest).toContain("2 lines");
  });

  test("Edit and Write also resolve via the path summary", () => {
    expect(
      summarizeToolInvocation("Edit", { file_path: "/a.ts" }, { content: "ok", isError: false })
    ).toContain("/a.ts");
    expect(
      summarizeToolInvocation("Write", { file_path: "/b.ts" }, { content: "ok", isError: false })
    ).toContain("/b.ts");
  });

  test("git_log resolves through the mcp__minsky__ prefix (mt#2787 normalization)", () => {
    const digest = summarizeToolInvocation(
      "mcp__minsky__git_log",
      { path: "." },
      { content: "", isError: false }
    );
    expect(digest).toContain(".");
  });

  test("tasks_search shows the query and a result count", () => {
    const digest = summarizeToolInvocation(
      "mcp__minsky__tasks_search",
      { query: "conversation view redesign" },
      { content: JSON.stringify([{ id: "mt#1" }, { id: "mt#2" }]), isError: false }
    );
    expect(digest).toContain("conversation view redesign");
    expect(digest).toContain("2 results");
  });

  test("memory_search shows the query", () => {
    const digest = summarizeToolInvocation("memory_search", { query: "cockpit design" }, undefined);
    expect(digest).toContain("cockpit design");
  });
});

describe("summarizeToolInvocation — generic fallback", () => {
  test("an unregistered tool falls back to the first scalar arg + outcome", () => {
    const digest = summarizeToolInvocation(
      "some_unregistered_tool",
      { taskId: "mt#2790" },
      { content: "ok", isError: false }
    );
    expect(digest).toContain("mt#2790");
    expect(digest).toContain("ok");
  });

  test("no args and no result still produces a digest without throwing", () => {
    expect(() => summarizeToolInvocation("noop", {}, undefined)).not.toThrow();
    expect(summarizeToolInvocation("noop", {}, undefined)).toBe("pending");
  });

  test("an errored result shows 'error', not the raw payload", () => {
    const digest = summarizeToolInvocation(
      "some_tool",
      { path: "x" },
      { content: "boom: stack trace…", isError: true }
    );
    expect(digest).toContain("error");
  });

  test("a specific entry that declines (shape mismatch) falls back to generic", () => {
    // Bash with no `command` field — commandSummary returns null → generic path.
    const digest = summarizeToolInvocation("Bash", { unexpected: "shape" }, undefined);
    expect(digest).toContain("shape");
  });
});

describe("genericOutcomeDigest", () => {
  test("pending when no result", () => {
    expect(genericOutcomeDigest(undefined)).toBe("pending");
  });
  test("error takes priority over content shape", () => {
    expect(genericOutcomeDigest({ content: "[]", isError: true })).toBe("error");
  });
  test("array result reports a count", () => {
    expect(genericOutcomeDigest({ content: JSON.stringify([1, 2, 3]), isError: false })).toBe(
      "3 results"
    );
  });
  test("singular result count", () => {
    expect(genericOutcomeDigest({ content: JSON.stringify([1]), isError: false })).toBe("1 result");
  });
  test("multi-line text reports a line count", () => {
    expect(genericOutcomeDigest({ content: "a\nb\nc", isError: false })).toBe("ok · 3 lines");
  });
  test("single-line text reports a byte count", () => {
    expect(genericOutcomeDigest({ content: "abcde", isError: false })).toBe("ok · 5b");
  });
  test("empty content is a bare ok", () => {
    expect(genericOutcomeDigest({ content: "", isError: false })).toBe("ok");
  });
});
