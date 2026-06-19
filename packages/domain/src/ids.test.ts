/**
 * mt#2524 — branded id types: compile-time + runtime guarantees.
 *
 * The `// @ts-expect-error` directives are the COMPILE-TIME assertion: if
 * branding regressed (e.g. a brand collapsed to plain `string`), the wrong-id
 * pass would compile, tsc would report the directive as UNUSED, and the
 * typecheck gate would fail. So `validate_typecheck` passing on this file
 * proves the id kinds are non-interchangeable at compile time.
 *
 * The runtime `expect()`s assert the complementary RUNTIME guarantee: brands
 * erase to the underlying string (zero runtime/wire change).
 */
import { describe, test, expect } from "bun:test";
import type { WorkspaceId, ConversationId, McpSessionId } from "./ids";

function needsWorkspaceId(id: WorkspaceId): WorkspaceId {
  return id;
}
function needsConversationId(id: ConversationId): ConversationId {
  return id;
}
function needsMcpSessionId(id: McpSessionId): McpSessionId {
  return id;
}

describe("branded id types (mt#2524)", () => {
  test("the wrong id kind cannot be passed where another is expected", () => {
    const ws = "ws-uuid" as WorkspaceId;
    const conv = "conv-uuid" as ConversationId;
    const mcp = "mcp-token" as McpSessionId;

    // @ts-expect-error — ConversationId is not assignable to WorkspaceId
    needsWorkspaceId(conv);
    // @ts-expect-error — WorkspaceId is not assignable to ConversationId
    needsConversationId(ws);
    // @ts-expect-error — McpSessionId is not assignable to WorkspaceId
    needsWorkspaceId(mcp);

    // The correct kinds compile cleanly and round-trip the value unchanged.
    expect(needsWorkspaceId(ws)).toBe("ws-uuid");
    expect(needsConversationId(conv)).toBe("conv-uuid");
    expect(needsMcpSessionId(mcp)).toBe("mcp-token");
  });

  test("a plain string cannot be passed where a branded id is expected", () => {
    // @ts-expect-error — a plain string is not assignable to a branded WorkspaceId
    needsWorkspaceId("just-a-string");

    // Minting requires an explicit cast (the boundary's job); then it compiles.
    const minted = "explicit-uuid" as WorkspaceId;
    expect(needsWorkspaceId(minted)).toBe("explicit-uuid");
  });

  test("brands erase at runtime — a branded id is a plain string on the wire", () => {
    const ws = "ws-uuid" as WorkspaceId;
    expect(typeof ws).toBe("string");
    expect(JSON.stringify({ id: ws })).toBe('{"id":"ws-uuid"}');
  });
});
