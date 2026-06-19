/**
 * mt#2524 — branded id types: compile-time + runtime guarantees.
 *
 * The `// @ts-expect-error` directives ARE the assertions: if branding
 * regressed (e.g. a brand collapsed to plain `string`), the wrong-id pass
 * would compile, tsc would report the directive as UNUSED, and the
 * typecheck gate would fail. So `validate_typecheck` passing on this file
 * proves the id kinds are non-interchangeable at compile time.
 */
import { describe, test, expect } from "bun:test";
import type { WorkspaceId, ConversationId, McpSessionId } from "./ids";

function needsWorkspaceId(_id: WorkspaceId): void {}
function needsConversationId(_id: ConversationId): void {}
function needsMcpSessionId(_id: McpSessionId): void {}

describe("branded id types (mt#2524)", () => {
  test("the wrong id kind cannot be passed where another is expected (compile error)", () => {
    const ws = "ws-uuid" as WorkspaceId;
    const conv = "conv-uuid" as ConversationId;
    const mcp = "mcp-token" as McpSessionId;

    // @ts-expect-error — ConversationId is not assignable to WorkspaceId
    needsWorkspaceId(conv);
    // @ts-expect-error — WorkspaceId is not assignable to ConversationId
    needsConversationId(ws);
    // @ts-expect-error — McpSessionId is not assignable to WorkspaceId
    needsWorkspaceId(mcp);

    // The correct kinds compile cleanly:
    needsWorkspaceId(ws);
    needsConversationId(conv);
    needsMcpSessionId(mcp);

    expect(true).toBe(true);
  });

  test("a plain string cannot be passed where a branded id is expected", () => {
    // @ts-expect-error — a plain string is not assignable to a branded WorkspaceId
    needsWorkspaceId("just-a-string");
    expect(true).toBe(true);
  });

  test("brands erase at runtime — a branded id is a plain string on the wire", () => {
    const ws = "ws-uuid" as WorkspaceId;
    expect(typeof ws).toBe("string");
    expect(JSON.stringify({ id: ws })).toBe('{"id":"ws-uuid"}');
  });
});
