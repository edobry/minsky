import { describe, expect, test } from "bun:test";
import { join } from "path";
import { resolveClaudeJsonPath } from "./claude-code-paths";

describe("resolveClaudeJsonPath (mt#5066)", () => {
  test("with CLAUDE_CONFIG_DIR set, the file lives inside that directory — where Claude Code 2.1.258 reads it", () => {
    expect(resolveClaudeJsonPath({ CLAUDE_CONFIG_DIR: "/sandbox/claude-config" }, "/home/op")).toBe(
      join("/sandbox/claude-config", ".claude.json")
    );
  });

  test("with the variable unset, the file is at the HOME root — not under ~/.claude", () => {
    expect(resolveClaudeJsonPath({}, "/home/op")).toBe(join("/home/op", ".claude.json"));
  });

  test("a blank variable counts as unset", () => {
    expect(resolveClaudeJsonPath({ CLAUDE_CONFIG_DIR: "   " }, "/home/op")).toBe(
      join("/home/op", ".claude.json")
    );
  });
});
