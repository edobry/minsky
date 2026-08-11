import { describe, test, expect } from "bun:test";
import {
  resolveConversationAgentId,
  injectAgentIdMeta,
  redactAgentId,
  AGENT_ID_META_KEY,
} from "./identity";
import type { JsonRpcMessage } from "./protocol";

const VALID_UUID = "e2e0f1d2-3c4b-4a5d-9e8f-0123456789ab";
const EXPECTED_AGENT_ID = `com.anthropic.claude-code:conv:${VALID_UUID}`;

describe("resolveConversationAgentId", () => {
  test("resolves a valid UUID env var into the canonical agentId", () => {
    expect(resolveConversationAgentId({ CLAUDE_CODE_SESSION_ID: VALID_UUID })).toBe(
      EXPECTED_AGENT_ID
    );
  });

  test("is case-insensitive and lowercases the id segment", () => {
    expect(resolveConversationAgentId({ CLAUDE_CODE_SESSION_ID: VALID_UUID.toUpperCase() })).toBe(
      EXPECTED_AGENT_ID
    );
  });

  test("returns null when the env var is absent (AT3 fall-through)", () => {
    expect(resolveConversationAgentId({})).toBeNull();
  });

  test("returns null when the env var is not UUID-shaped (AT4 fall-through)", () => {
    expect(resolveConversationAgentId({ CLAUDE_CODE_SESSION_ID: "not-a-uuid" })).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(resolveConversationAgentId({ CLAUDE_CODE_SESSION_ID: "" })).toBeNull();
  });
});

describe("injectAgentIdMeta", () => {
  test("stamps _meta on a tools/call request with no existing _meta", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tasks_get", arguments: { taskId: "mt#3812" } },
    };
    const result = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);
    expect(result).not.toBeNull();
    expect((result?.params as Record<string, unknown>)["_meta"]).toEqual({
      [AGENT_ID_META_KEY]: EXPECTED_AGENT_ID,
    });
    // original untouched
    expect(msg.params?.["_meta"]).toBeUndefined();
  });

  test("does NOT overwrite an already-present agent_id (AT2)", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "tasks_get",
        _meta: { [AGENT_ID_META_KEY]: "minsky.native-subagent:task:mt#1@parent" },
      },
    };
    const result = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);
    expect(result).toBeNull();
  });

  test("preserves other _meta keys when stamping", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "x", _meta: { progressToken: "abc" } },
    };
    const result = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);
    expect((result?.params as Record<string, unknown>)["_meta"]).toEqual({
      progressToken: "abc",
      [AGENT_ID_META_KEY]: EXPECTED_AGENT_ID,
    });
  });

  test("returns null for non-tools/call methods (e.g. initialize)", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    };
    expect(injectAgentIdMeta(msg, EXPECTED_AGENT_ID)).toBeNull();
  });

  test("returns null when params is missing", () => {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call" };
    expect(injectAgentIdMeta(msg, EXPECTED_AGENT_ID)).toBeNull();
  });

  test("returns null when params is an array", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: [] as unknown as Record<string, unknown>,
    };
    expect(injectAgentIdMeta(msg, EXPECTED_AGENT_ID)).toBeNull();
  });
});

describe("redactAgentId", () => {
  test("truncates the id segment to 8 chars, keeps kind:scope", () => {
    expect(redactAgentId(EXPECTED_AGENT_ID)).toBe("com.anthropic.claude-code:conv:e2e0f1d2…");
  });
});
