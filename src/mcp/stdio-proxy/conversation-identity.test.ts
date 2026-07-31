/**
 * Tests for conversation-scoped agent identity injection (mt#3285).
 *
 * Covers the resolver (env → agentId) and the pure injection helper the
 * inbound transform delegates to. Transform-level integration lives in
 * proxy.test.ts alongside the other transform tests.
 */

import { describe, test, expect } from "bun:test";
import { AGENT_ID_META_KEY } from "@minsky/domain/agent-identity/layer2";
import {
  CLAUDE_CODE_SESSION_ID_ENV,
  resolveConversationAgentId,
  injectAgentIdMeta,
  redactAgentId,
} from "./conversation-identity";
import type { JsonRpcMessage } from "./tools";

const CONV_UUID = "6c6fdc74-d1b5-424f-a854-6f875b977dd2";
const EXPECTED_AGENT_ID = `com.anthropic.claude-code:conv:${CONV_UUID}`;

describe("resolveConversationAgentId", () => {
  test("builds a conv-scoped agentId from a UUID env value", () => {
    const agentId = resolveConversationAgentId({ [CLAUDE_CODE_SESSION_ID_ENV]: CONV_UUID });
    expect(agentId).toBe(EXPECTED_AGENT_ID);
  });

  test("trims surrounding whitespace and lowercases the UUID", () => {
    const agentId = resolveConversationAgentId({
      [CLAUDE_CODE_SESSION_ID_ENV]: `  ${CONV_UUID.toUpperCase()}  `,
    });
    expect(agentId).toBe(EXPECTED_AGENT_ID);
  });

  test("returns null when the env var is absent", () => {
    expect(resolveConversationAgentId({})).toBeNull();
  });

  test("returns null for an empty value", () => {
    expect(resolveConversationAgentId({ [CLAUDE_CODE_SESSION_ID_ENV]: "" })).toBeNull();
    expect(resolveConversationAgentId({ [CLAUDE_CODE_SESSION_ID_ENV]: "   " })).toBeNull();
  });

  test("returns null for non-UUID values (negative control, spec AT4)", () => {
    for (const bad of [
      "not-a-uuid",
      "6c6fdc74",
      `${CONV_UUID}-extra`,
      `prefix-${CONV_UUID}`,
      "6c6fdc74_d1b5_424f_a854_6f875b977dd2",
      "gggggggg-gggg-gggg-gggg-gggggggggggg",
    ]) {
      expect(resolveConversationAgentId({ [CLAUDE_CODE_SESSION_ID_ENV]: bad })).toBeNull();
    }
  });
});

describe("redactAgentId", () => {
  test("keeps kind and scope, truncates the uuid segment to 8 chars", () => {
    expect(redactAgentId(EXPECTED_AGENT_ID)).toBe("com.anthropic.claude-code:conv:6c6fdc74…");
    expect(redactAgentId(EXPECTED_AGENT_ID)).not.toContain(CONV_UUID);
  });

  test("degrades safely on a colon-free input", () => {
    expect(redactAgentId("abcdefghijklmnop")).toBe("abcdefgh…");
  });
});

describe("injectAgentIdMeta", () => {
  function toolsCall(params: Record<string, unknown>): JsonRpcMessage {
    return { jsonrpc: "2.0", id: 7, method: "tools/call", params };
  }

  function expectInjected(msg: JsonRpcMessage | null): JsonRpcMessage {
    if (!msg) throw new Error("expected injection to apply");
    return msg;
  }

  test("stamps the agentId into a tools/call request's _meta", () => {
    const msg = toolsCall({ name: "tasks_get", arguments: { taskId: "mt#1" } });
    const injected = expectInjected(injectAgentIdMeta(msg, EXPECTED_AGENT_ID));

    const meta = (injected.params as Record<string, unknown>)["_meta"] as Record<string, unknown>;
    expect(meta[AGENT_ID_META_KEY]).toBe(EXPECTED_AGENT_ID);
    // Tool name and arguments pass through untouched.
    expect((injected.params as Record<string, unknown>)["name"]).toBe("tasks_get");
    expect((injected.params as Record<string, unknown>)["arguments"]).toEqual({ taskId: "mt#1" });
  });

  test("preserves existing _meta keys (progressToken)", () => {
    const msg = toolsCall({ name: "t", arguments: {}, _meta: { progressToken: 42 } });
    const injected = expectInjected(injectAgentIdMeta(msg, EXPECTED_AGENT_ID));

    const meta = (injected.params as Record<string, unknown>)["_meta"] as Record<string, unknown>;
    expect(meta["progressToken"]).toBe(42);
    expect(meta[AGENT_ID_META_KEY]).toBe(EXPECTED_AGENT_ID);
  });

  test("does NOT overwrite an already-declared agent_id (mt#2292 forward-compat)", () => {
    const declared = "minsky.native-subagent:run:mt#99@com.anthropic.claude-code:conv:abc";
    const msg = toolsCall({ name: "t", arguments: {}, _meta: { [AGENT_ID_META_KEY]: declared } });
    expect(injectAgentIdMeta(msg, EXPECTED_AGENT_ID)).toBeNull();
  });

  test("returns null for non-tools/call frames", () => {
    const frames: JsonRpcMessage[] = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 3, result: { ok: true } },
    ];
    for (const frame of frames) {
      expect(injectAgentIdMeta(frame, EXPECTED_AGENT_ID)).toBeNull();
    }
  });

  test("returns null when params is missing or not an object", () => {
    expect(injectAgentIdMeta({ jsonrpc: "2.0", id: 4, method: "tools/call" }, "x")).toBeNull();
    expect(
      injectAgentIdMeta(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: [] as unknown as Record<string, unknown>,
        },
        "x"
      )
    ).toBeNull();
  });

  test("does not mutate the original message", () => {
    const params = { name: "t", arguments: { a: 1 } };
    const msg = toolsCall(params);
    const injected = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);

    expect(injected).not.toBe(msg);
    expect(msg.params).toBe(params);
    expect("_meta" in (msg.params as Record<string, unknown>)).toBe(false);
  });
});
