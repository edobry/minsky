/**
 * checkDerivation — derivation-discipline heuristics (mt#960) plus the
 * mt#2705 defensive guard for non-string input.
 *
 * The non-string-input guard is belt-and-suspenders: the primary fix for the
 * incident that motivated it (mt#3144's `memory.create` MCP-path crash on an
 * omitted `content` param) lives at the command boundary
 * (`convertMcpArgsToParameters` / `normalizeCliParameters`), which now
 * rejects a missing required parameter before `execute()` ever calls
 * `checkDerivation`. This file additionally exercises `checkDerivation`
 * directly so a future boundary bypass (a direct `execute()` call, a test,
 * or a not-yet-existing adapter) degrades to a typed rejection rather than
 * a raw TypeError.
 */
import { describe, test, expect } from "bun:test";
import { checkDerivation } from "./validation";

describe("checkDerivation — derivation-discipline heuristics (mt#960)", () => {
  test("flags content that names a code artifact", () => {
    const issue = checkDerivation("The function foo() does something.");
    expect(issue?.source).toBe("code");
  });

  test("flags content that cites a git commit hash", () => {
    const issue = checkDerivation("The commit 1234567 fixed the bug.");
    expect(issue?.source).toBe("git");
  });

  test("flags content that cites a task's status/spec/title", () => {
    const issue = checkDerivation("Task mt#123 status is DONE.");
    expect(issue?.source).toBe("task");
  });

  test("flags content that is mostly a fenced code block", () => {
    const issue = checkDerivation(`\`\`\`\n${"x".repeat(200)}\n\`\`\``);
    expect(issue?.source).toBe("quoted");
  });

  test("passes genuine cross-conversation insight through", () => {
    const issue = checkDerivation(
      "The user prefers terse commit messages and dislikes emoji in PR bodies."
    );
    expect(issue).toBeNull();
  });
});

describe("checkDerivation — defensive guard for non-string input (mt#2705)", () => {
  test("undefined content returns a typed rejection instead of throwing", () => {
    // Regression test: previously `content.trimStart()` threw a raw
    // TypeError ("undefined is not an object (evaluating '$.trimStart')")
    // when `content` was `undefined` — the exact shape of the mt#3144
    // memory.create incident on the (pre-fix) MCP path.
    expect(() => checkDerivation(undefined as unknown as string)).not.toThrow();
    const issue = checkDerivation(undefined as unknown as string);
    expect(issue?.source).toBe("invalid-input");
    expect(issue?.message).toContain("must be a string");
  });

  test("null content returns a typed rejection instead of throwing", () => {
    expect(() => checkDerivation(null as unknown as string)).not.toThrow();
    const issue = checkDerivation(null as unknown as string);
    expect(issue?.source).toBe("invalid-input");
    expect(issue?.message).toContain("null");
  });

  test("non-string, non-null content (e.g. a number or object) returns a typed rejection", () => {
    const numIssue = checkDerivation(42 as unknown as string);
    expect(numIssue?.source).toBe("invalid-input");
    expect(numIssue?.message).toContain("number");

    const objIssue = checkDerivation({ not: "a string" } as unknown as string);
    expect(objIssue?.source).toBe("invalid-input");
    expect(objIssue?.message).toContain("object");
  });

  test("a genuine empty string is NOT treated as invalid input (distinct from undefined)", () => {
    // Empty string is a valid (if unusual) string value — it must pass
    // through the normal heuristics, not the invalid-input guard.
    const issue = checkDerivation("");
    expect(issue).toBeNull();
  });
});
