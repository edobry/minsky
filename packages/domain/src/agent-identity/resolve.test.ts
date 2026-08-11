/**
 * Unit tests for priority resolver (ADR-006).
 */
import { describe, test, expect } from "bun:test";
import {
  resolveAgentId,
  resolveAgentIdParsed,
  resolveAgentIdWithLayer,
  type IdentityFallbackEvent,
} from "./resolve";
import { AGENT_ID_META_KEY } from "./layer2";
import { BAGGAGE_META_KEY, GEN_AI_CONVERSATION_ID_KEY } from "./baggage";
import { buildDeclaredIdentityKeys } from "./declared";
import { KNOWN_KINDS } from "./kinds";
import type { ProcessSignals } from "./layer1";

const BASE_SIGNALS: ProcessSignals = {
  hostname: "test-host",
  username: "testuser",
  pid: 99999,
  startTimeMs: 1700000000000,
};

const VALID_DECLARED_ID =
  "minsky.native-subagent:run:task-mt123@com.anthropic.claude-code:proc:a1b2c3d4";

describe("resolveAgentId (string output)", () => {
  test("returns a non-empty string always", () => {
    const id = resolveAgentId({ signals: BASE_SIGNALS });
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  test("returns a parseable agentId format", () => {
    const id = resolveAgentId({ clientInfo: { name: "claude-code" }, signals: BASE_SIGNALS });
    // Must be in form kind:scope:id (with optional @parent)
    expect(id).toMatch(/^[^:@]+:[^:@]+:[^@]+/);
  });

  test("Layer 2 wins over Layer 1 when _meta is set", () => {
    const id = resolveAgentId({
      clientInfo: { name: "claude-code" },
      extras: { _meta: { [AGENT_ID_META_KEY]: VALID_DECLARED_ID } },
      signals: BASE_SIGNALS,
    });
    expect(id).toBe(VALID_DECLARED_ID);
  });

  test("falls back to Layer 1 when _meta is absent", () => {
    const id = resolveAgentId({
      clientInfo: { name: "claude-code" },
      extras: {},
      signals: BASE_SIGNALS,
    });
    expect(id).toContain(KNOWN_KINDS.CLAUDE_CODE);
    expect(id).toContain(":proc:");
  });

  test("falls back to Layer 1 when _meta agent_id is malformed", () => {
    const id = resolveAgentId({
      clientInfo: { name: "claude-code" },
      extras: { _meta: { [AGENT_ID_META_KEY]: "not-valid" } },
      signals: BASE_SIGNALS,
    });
    // Should be Layer 1 result — not the malformed string
    expect(id).not.toBe("not-valid");
    expect(id).toContain(KNOWN_KINDS.CLAUDE_CODE);
  });

  test("Layer 3 wins over Layer 2 when provided", () => {
    const layer3: import("./format").ParsedAgentId = {
      kind: "com.anthropic.claude-code",
      scope: "conv",
      id: "layer3-conv-id",
    };
    const id = resolveAgentId({
      extras: { _meta: { [AGENT_ID_META_KEY]: VALID_DECLARED_ID } },
      signals: BASE_SIGNALS,
      layer3Result: layer3,
    });
    expect(id).toBe("com.anthropic.claude-code:conv:layer3-conv-id");
  });
});

describe("resolveAgentIdParsed (structured output)", () => {
  test("Layer 1 result has correct kind for known clientInfo", () => {
    const parsed = resolveAgentIdParsed({
      clientInfo: { name: "claude-code" },
      signals: BASE_SIGNALS,
    });
    expect(parsed.kind).toBe(KNOWN_KINDS.CLAUDE_CODE);
    expect(parsed.scope).toBe("proc");
    expect(parsed.id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("Layer 2 result preserves parent chain from _meta", () => {
    const parsed = resolveAgentIdParsed({
      extras: { _meta: { [AGENT_ID_META_KEY]: VALID_DECLARED_ID } },
      signals: BASE_SIGNALS,
    });
    expect(parsed.kind).toBe("minsky.native-subagent");
    expect(parsed.parent).toBe("com.anthropic.claude-code:proc:a1b2c3d4");
  });

  test("Layer 1 hash is stable across multiple calls with same signals", () => {
    const p1 = resolveAgentIdParsed({ clientInfo: { name: "claude-code" }, signals: BASE_SIGNALS });
    const p2 = resolveAgentIdParsed({ clientInfo: { name: "claude-code" }, signals: BASE_SIGNALS });
    expect(p1.id).toBe(p2.id);
  });

  test("Layer 1 hash differs for different pids", () => {
    const p1 = resolveAgentIdParsed({
      clientInfo: { name: "claude-code" },
      signals: { ...BASE_SIGNALS, pid: 111 },
    });
    const p2 = resolveAgentIdParsed({
      clientInfo: { name: "claude-code" },
      signals: { ...BASE_SIGNALS, pid: 222 },
    });
    expect(p1.id).not.toBe(p2.id);
  });
});

describe("resolveAgentIdWithLayer (provenance output, mt#3986)", () => {
  const CONVERSATION_UUID = "2154425b-1c30-4f0e-9d51-0b73b9a2f5a1";
  const OTHER_UUID = "9f8e7d6c-5b4a-4392-8271-605f4e3d2c1b";

  test("AT1: resolves from baggage alone and reports the key and layer", () => {
    const resolution = resolveAgentIdWithLayer({
      clientInfo: { name: "claude-code" },
      extras: {
        _meta: { [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${CONVERSATION_UUID}` },
      },
      signals: BASE_SIGNALS,
    });

    expect(resolution.agentId).toBe(`${KNOWN_KINDS.CLAUDE_CODE}:conv:${CONVERSATION_UUID}`);
    expect(resolution.keyThatAnswered).toBe(BAGGAGE_META_KEY);
    // Layer 2, not 3: the reader cannot distinguish a stamped id from a
    // cooperating caller's declared one — see resolve.ts's docblock.
    expect(resolution.layer).toBe(2);
  });

  test("AT2: honors ORDER when both keys carry DIFFERENT ids", () => {
    const resolution = resolveAgentIdWithLayer({
      clientInfo: { name: "claude-code" },
      extras: {
        _meta: {
          [AGENT_ID_META_KEY]: `${KNOWN_KINDS.CLAUDE_CODE}:conv:${CONVERSATION_UUID}`,
          [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${OTHER_UUID}`,
        },
      },
      signals: BASE_SIGNALS,
    });

    expect(resolution.agentId).toContain(CONVERSATION_UUID);
    expect(resolution.agentId).not.toContain(OTHER_UUID);
    expect(resolution.keyThatAnswered).toBe(AGENT_ID_META_KEY);
  });

  test("AT3: falls back to Layer 1 and emits the tried keys plus the answering layer", () => {
    // Observed through an injected sink, not a patched logger (ADR-036).
    const events: IdentityFallbackEvent[] = [];

    const resolution = resolveAgentIdWithLayer({
      clientInfo: { name: "claude-code" },
      extras: { _meta: { unrelated: "x" } },
      signals: BASE_SIGNALS,
      onFallback: (event) => events.push(event),
    });

    expect(resolution.layer).toBe(1);
    expect(resolution.keyThatAnswered).toBeNull();
    expect(events.length).toBe(1);
    expect(events[0]?.keysTried).toEqual([AGENT_ID_META_KEY, BAGGAGE_META_KEY]);
    expect(events[0]?.layer).toBe(1);
    expect(events[0]?.agentId).toBe(resolution.agentId);
  });

  test("AT3: the tried-keys list reflects a configured protocol key", () => {
    const events: IdentityFallbackEvent[] = [];

    resolveAgentIdWithLayer({
      clientInfo: { name: "claude-code" },
      signals: BASE_SIGNALS,
      declaredKeys: buildDeclaredIdentityKeys("io.modelcontextprotocol/conversationId"),
      onFallback: (event) => events.push(event),
    });

    expect(events[0]?.keysTried).toEqual([
      AGENT_ID_META_KEY,
      BAGGAGE_META_KEY,
      "io.modelcontextprotocol/conversationId",
    ]);
  });

  test("does NOT emit a fallback event when a declared key answers", () => {
    const events: IdentityFallbackEvent[] = [];

    resolveAgentIdWithLayer({
      clientInfo: { name: "claude-code" },
      extras: { _meta: { [AGENT_ID_META_KEY]: VALID_DECLARED_ID } },
      signals: BASE_SIGNALS,
      onFallback: (event) => events.push(event),
    });

    expect(events.length).toBe(0);
  });

  test("fires the fallback sink exactly once per call, via any entry point", () => {
    const events: IdentityFallbackEvent[] = [];
    const inputs = {
      clientInfo: { name: "claude-code" },
      signals: BASE_SIGNALS,
      onFallback: (event: IdentityFallbackEvent) => events.push(event),
    };

    resolveAgentId(inputs);
    expect(events.length).toBe(1);

    resolveAgentIdParsed(inputs);
    expect(events.length).toBe(2);
  });

  test("keeps resolveAgentId and resolveAgentIdParsed consistent with the resolution", () => {
    const inputs = {
      clientInfo: { name: "claude-code" },
      extras: {
        _meta: { [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${CONVERSATION_UUID}` },
      },
      signals: BASE_SIGNALS,
    };

    const resolution = resolveAgentIdWithLayer(inputs);
    expect(resolveAgentId(inputs)).toBe(resolution.agentId);
    expect(resolveAgentIdParsed(inputs)).toEqual(resolution.parsed);
  });
});
