/**
 * Tests for tool-call-projection-fields.ts: tool-name parsing and the
 * arg_fingerprint hash.
 *
 * @see mt#3329 — tool-call-projection-fields.ts
 */

import { describe, test, expect } from "bun:test";

import { parseToolName, computeArgFingerprint } from "./tool-call-projection-fields";

describe("parseToolName", () => {
  test("splits an MCP tool name into server + bare name", () => {
    expect(parseToolName("mcp__minsky__session_edit_file")).toEqual({
      server: "minsky",
      name: "session_edit_file",
    });
  });

  test("splits an MCP tool name with underscores in the bare name", () => {
    expect(parseToolName("mcp__github__list_pull_requests")).toEqual({
      server: "github",
      name: "list_pull_requests",
    });
  });

  test("returns null server for a non-MCP built-in tool", () => {
    expect(parseToolName("Bash")).toEqual({ server: null, name: "Bash" });
    expect(parseToolName("Edit")).toEqual({ server: null, name: "Edit" });
    expect(parseToolName("Agent")).toEqual({ server: null, name: "Agent" });
  });

  test("does not misparse a name that merely contains 'mcp' as a substring", () => {
    expect(parseToolName("mcpish_tool")).toEqual({ server: null, name: "mcpish_tool" });
  });
});

describe("computeArgFingerprint", () => {
  test("is deterministic for the same input", () => {
    const input = { path: "/tmp/foo.ts", content: "hello" };
    expect(computeArgFingerprint(input)).toBe(computeArgFingerprint({ ...input }));
  });

  test("is independent of object key order", () => {
    const a = { b: 2, a: 1, path: "/tmp/foo.ts" };
    const b = { path: "/tmp/foo.ts", a: 1, b: 2 };
    expect(computeArgFingerprint(a)).toBe(computeArgFingerprint(b));
  });

  test("differs for logically different inputs", () => {
    const fp1 = computeArgFingerprint({ path: "/tmp/foo.ts" });
    const fp2 = computeArgFingerprint({ path: "/tmp/bar.ts" });
    expect(fp1).not.toBe(fp2);
  });

  test("normalizes absolute session-workspace paths so identical calls in different sessions match", () => {
    const inputA = {
      path: "/Users/edobry/.local/state/minsky/sessions/5b26f164-eb48-4da1-83e2-cbcf0f72f5da/src/foo.ts",
    };
    const inputB = {
      path: "/Users/edobry/.local/state/minsky/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/src/foo.ts",
    };
    expect(computeArgFingerprint(inputA)).toBe(computeArgFingerprint(inputB));
  });

  test("does not collapse genuinely different paths within the same normalized session prefix", () => {
    const inputA = {
      path: "/Users/edobry/.local/state/minsky/sessions/5b26f164-eb48-4da1-83e2-cbcf0f72f5da/src/foo.ts",
    };
    const inputB = {
      path: "/Users/edobry/.local/state/minsky/sessions/5b26f164-eb48-4da1-83e2-cbcf0f72f5da/src/bar.ts",
    };
    expect(computeArgFingerprint(inputA)).not.toBe(computeArgFingerprint(inputB));
  });

  test("handles null/undefined input without throwing", () => {
    expect(() => computeArgFingerprint(null)).not.toThrow();
    expect(() => computeArgFingerprint(undefined)).not.toThrow();
    expect(computeArgFingerprint(null)).toBe(computeArgFingerprint(undefined));
  });

  test("produces a short, fixed-length hex fingerprint", () => {
    const fp = computeArgFingerprint({ a: 1 });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  test("never contains the raw input value as a substring (spot check for a distinctive secret-shaped string)", () => {
    const secretLike = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const fp = computeArgFingerprint({ apiKey: secretLike });
    expect(fp).not.toContain(secretLike);
  });
});
