/** Tests for parseToolName (mt#2787) — raw transcript name → server + bare name. */
import { describe, test, expect } from "bun:test";
import { parseToolName } from "./tool-name";

describe("parseToolName", () => {
  test("mcp-prefixed name splits into server + bare name", () => {
    expect(parseToolName("mcp__minsky__tasks_list")).toEqual({
      server: "minsky",
      name: "tasks_list",
    });
  });

  test("bare tool name stays bare with null server", () => {
    expect(parseToolName("tasks_list")).toEqual({ server: null, name: "tasks_list" });
  });

  test("harness-native tools are unprefixed", () => {
    expect(parseToolName("Bash")).toEqual({ server: null, name: "Bash" });
  });

  test("server names containing single underscores and hyphens parse at the first __ boundary", () => {
    expect(parseToolName("mcp__claude_ai_Gmail__get_message")).toEqual({
      server: "claude_ai_Gmail",
      name: "get_message",
    });
    expect(parseToolName("mcp__chrome-devtools__take_snapshot")).toEqual({
      server: "chrome-devtools",
      name: "take_snapshot",
    });
  });

  test("a tool name that itself starts with __ keeps the leading underscores", () => {
    expect(parseToolName("mcp__minsky____proxy_restart_server")).toEqual({
      server: "minsky",
      name: "__proxy_restart_server",
    });
  });

  test("multi-segment tool names keep all segments", () => {
    expect(parseToolName("mcp__minsky__session_pr_wait-for-review")).toEqual({
      server: "minsky",
      name: "session_pr_wait-for-review",
    });
  });
});
