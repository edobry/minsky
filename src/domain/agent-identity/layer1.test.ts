/**
 * Unit tests for Layer 1 ascribed resolver (ADR-006).
 */
import { describe, test, expect } from "bun:test";
import { buildLayer1HashId, resolveLayer1, type ProcessSignals, type Layer1Config } from "./layer1";
import { KNOWN_KINDS } from "./kinds";

const BASE_SIGNALS: ProcessSignals = {
  hostname: "test-host.example.com",
  username: "testuser",
  pid: 12345,
  startTimeMs: 1700000000000,
};

describe("buildLayer1HashId", () => {
  test("returns 16 hex characters", () => {
    const id = buildLayer1HashId(BASE_SIGNALS);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is stable for identical inputs", () => {
    const id1 = buildLayer1HashId(BASE_SIGNALS);
    const id2 = buildLayer1HashId(BASE_SIGNALS);
    expect(id1).toBe(id2);
  });

  test("differs when pid changes", () => {
    const sig1 = { ...BASE_SIGNALS, pid: 1111 };
    const sig2 = { ...BASE_SIGNALS, pid: 2222 };
    expect(buildLayer1HashId(sig1)).not.toBe(buildLayer1HashId(sig2));
  });

  test("differs when startTimeMs changes", () => {
    const sig1 = { ...BASE_SIGNALS, startTimeMs: 1700000000000 };
    const sig2 = { ...BASE_SIGNALS, startTimeMs: 1700000001234 };
    expect(buildLayer1HashId(sig1)).not.toBe(buildLayer1HashId(sig2));
  });

  test("differs when hostname changes (hash mode)", () => {
    const sig1 = { ...BASE_SIGNALS, hostname: "host-a" };
    const sig2 = { ...BASE_SIGNALS, hostname: "host-b" };
    expect(buildLayer1HashId(sig1)).not.toBe(buildLayer1HashId(sig2));
  });

  test("differs when username changes", () => {
    const sig1 = { ...BASE_SIGNALS, username: "alice" };
    const sig2 = { ...BASE_SIGNALS, username: "bob" };
    expect(buildLayer1HashId(sig1)).not.toBe(buildLayer1HashId(sig2));
  });

  describe("hostname hashing", () => {
    const config: Layer1Config = { hashHostname: false };

    test("raw-hostname mode produces different hash than hashed-hostname mode", () => {
      const hashedId = buildLayer1HashId(BASE_SIGNALS, { hashHostname: true });
      const rawId = buildLayer1HashId(BASE_SIGNALS, config);
      // Different because the hostname component is processed differently
      expect(hashedId).not.toBe(rawId);
    });

    test("raw-hostname mode is still stable for same inputs", () => {
      const id1 = buildLayer1HashId(BASE_SIGNALS, config);
      const id2 = buildLayer1HashId(BASE_SIGNALS, config);
      expect(id1).toBe(id2);
    });
  });
});

describe("resolveLayer1", () => {
  test("returns parsed agentId with known kind", () => {
    const result = resolveLayer1({ name: "claude-code" }, BASE_SIGNALS);
    expect(result.kind).toBe(KNOWN_KINDS.CLAUDE_CODE);
    expect(result.scope).toBe("proc");
    expect(result.id).toMatch(/^[0-9a-f]{16}$/);
    expect(result.parent).toBeUndefined();
  });

  test("uses 'hash' scope for unknown kind", () => {
    const result = resolveLayer1({ name: undefined }, BASE_SIGNALS);
    expect(result.kind).toBe(KNOWN_KINDS.UNKNOWN);
    expect(result.scope).toBe("hash");
  });

  test("produces same id for same process signals", () => {
    const r1 = resolveLayer1({ name: "claude-code" }, BASE_SIGNALS);
    const r2 = resolveLayer1({ name: "claude-code" }, BASE_SIGNALS);
    expect(r1.id).toBe(r2.id);
  });

  test("produces different ids for different pids", () => {
    const r1 = resolveLayer1({ name: "claude-code" }, { ...BASE_SIGNALS, pid: 100 });
    const r2 = resolveLayer1({ name: "claude-code" }, { ...BASE_SIGNALS, pid: 200 });
    expect(r1.id).not.toBe(r2.id);
  });

  test("produces different ids for different start times", () => {
    const r1 = resolveLayer1({ name: "claude-code" }, { ...BASE_SIGNALS, startTimeMs: 1000 });
    const r2 = resolveLayer1({ name: "claude-code" }, { ...BASE_SIGNALS, startTimeMs: 2000 });
    expect(r1.id).not.toBe(r2.id);
  });
});
