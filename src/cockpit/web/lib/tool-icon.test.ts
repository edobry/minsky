/**
 * Tests for per-family tool icon selection (mt#2790).
 */
import { describe, test, expect } from "bun:test";
import {
  Terminal,
  FileText,
  GitBranch,
  ListTodo,
  BrainCircuit,
  Bot,
  Plug,
  Wrench,
} from "lucide-react";
import { toolIconFor } from "./tool-icon";
import { parseToolName } from "./tool-name";

describe("toolIconFor", () => {
  test("shell tools (Bash, session_exec) get the Terminal icon", () => {
    expect(toolIconFor(parseToolName("Bash"))).toBe(Terminal);
    expect(toolIconFor(parseToolName("session_exec"))).toBe(Terminal);
  });

  test("file-op tools get the FileText icon", () => {
    expect(toolIconFor(parseToolName("Read"))).toBe(FileText);
    expect(toolIconFor(parseToolName("Edit"))).toBe(FileText);
    expect(toolIconFor(parseToolName("Write"))).toBe(FileText);
    expect(toolIconFor(parseToolName("mcp__minsky__session_read_file"))).toBe(FileText);
  });

  test("git_* tools get the GitBranch icon", () => {
    expect(toolIconFor(parseToolName("mcp__minsky__git_log"))).toBe(GitBranch);
    expect(toolIconFor(parseToolName("git_diff"))).toBe(GitBranch);
  });

  test("tasks_* tools get the ListTodo icon", () => {
    expect(toolIconFor(parseToolName("mcp__minsky__tasks_search"))).toBe(ListTodo);
  });

  test("memory_* tools get the BrainCircuit icon", () => {
    expect(toolIconFor(parseToolName("mcp__minsky__memory_search"))).toBe(BrainCircuit);
  });

  test("Agent (subagent spawn) gets the Bot icon", () => {
    expect(toolIconFor(parseToolName("Agent"))).toBe(Bot);
  });

  test("an unrecognized MCP tool gets the generic Plug icon", () => {
    expect(toolIconFor(parseToolName("mcp__github__list_pull_requests"))).toBe(Plug);
  });

  test("an unrecognized native tool gets the generic Wrench icon", () => {
    expect(toolIconFor(parseToolName("WebFetch"))).toBe(Wrench);
  });
});
