/**
 * Unit tests for priority resolver (ADR-006).
 */
import { describe, test, expect } from "bun:test";
import { resolveAgentId, resolveAgentIdParsed } from "./resolve";
import { AGENT_ID_META_KEY } from "./layer2";
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
