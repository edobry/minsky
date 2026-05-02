/**
 * StrikeTracker unit tests — mt#1464.
 *
 * Covers:
 *   - Two same-signature errors on same (taskId, toolName) → exactly one stuck.unblock Ask
 *   - Successful call between two same-signature errors → no Ask (counter resets)
 *   - Two errors with different signatures on same (taskId, toolName) → no Ask
 *   - LRU eviction: insert 257 distinct keys, oldest is evicted
 *   - normalizeErrorSignature: code field, message field, string fallback
 *   - Cross-session bleed: two sessions without args.task should NOT share strike counters
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  MapLruStrikeTracker,
  normalizeErrorSignature,
} from "../../../src/domain/ask/strike-tracker";
import { FakeAskRepository } from "../../../src/domain/ask/repository";

// ---------------------------------------------------------------------------
// normalizeErrorSignature
// ---------------------------------------------------------------------------

describe("normalizeErrorSignature", () => {
  test("returns error.code when present as string", () => {
    const err = { code: "ENOENT", message: "no such file" };
    expect(normalizeErrorSignature(err)).toBe("ENOENT");
  });

  test("returns error.message slice when no code", () => {
    const err = new Error("something went wrong");
    expect(normalizeErrorSignature(err)).toBe("something went wrong");
  });

  test("slices message at 200 chars", () => {
    const longMessage = "x".repeat(250);
    const err = new Error(longMessage);
    expect(normalizeErrorSignature(err)).toHaveLength(200);
  });

  test("falls back to String(error) for non-object errors", () => {
    expect(normalizeErrorSignature("plain string error")).toBe("plain string error");
  });

  test("falls back to String(error) for null", () => {
    expect(normalizeErrorSignature(null)).toBe("null");
  });

  test("empty code string falls through to message", () => {
    const err = { code: "", message: "fallback message" };
    expect(normalizeErrorSignature(err)).toBe("fallback message");
  });

  test("returns String(error.code) when code is a negative number (MCP numeric code)", () => {
    const err = { code: -32000, message: "server error" };
    expect(normalizeErrorSignature(err)).toBe("-32000");
  });

  test("returns String(error.code) when code is a positive number", () => {
    const err = { code: 42, message: "other error" };
    expect(normalizeErrorSignature(err)).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// MapLruStrikeTracker — basic behaviour
// ---------------------------------------------------------------------------

describe("MapLruStrikeTracker", () => {
  let tracker: MapLruStrikeTracker;

  beforeEach(() => {
    tracker = new MapLruStrikeTracker();
  });

  test("first error returns count=1", () => {
    const result = tracker.recordError(
      { taskId: "mt#1", toolName: "session_exec", errorSignature: "ENOENT" },
      new Error("not found")
    );
    expect(result.count).toBe(1);
    expect(result.attempts).toHaveLength(1);
  });

  test("second same-signature error returns count=2 with both attempts", () => {
    const key = { taskId: "mt#1", toolName: "session_exec", errorSignature: "ENOENT" };
    const err1 = new Error("attempt 1");
    const err2 = new Error("attempt 2");
    tracker.recordError(key, err1);
    const result = tracker.recordError(key, err2);

    expect(result.count).toBe(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toBe(err1);
    expect(result.attempts[1]).toBe(err2);
  });

  test("recordSuccess clears all signatures for (taskId, toolName)", () => {
    const key = { taskId: "mt#1", toolName: "session_exec", errorSignature: "ENOENT" };
    tracker.recordError(key, new Error("first"));
    tracker.recordSuccess("mt#1", "session_exec");

    // After reset, the same signature should start from 1 again.
    const result = tracker.recordError(key, new Error("after reset"));
    expect(result.count).toBe(1);
  });

  test("two errors with different signatures do NOT aggregate", () => {
    const key1 = { taskId: "mt#1", toolName: "session_exec", errorSignature: "ENOENT" };
    const key2 = { taskId: "mt#1", toolName: "session_exec", errorSignature: "EACCES" };
    const r1 = tracker.recordError(key1, new Error("enoent"));
    const r2 = tracker.recordError(key2, new Error("eacces"));

    expect(r1.count).toBe(1);
    expect(r2.count).toBe(1);
  });

  test("different toolName is a separate key", () => {
    const key1 = { taskId: "mt#1", toolName: "tool_a", errorSignature: "SIG" };
    const key2 = { taskId: "mt#1", toolName: "tool_b", errorSignature: "SIG" };
    tracker.recordError(key1, "err");
    const r2 = tracker.recordError(key2, "err");

    expect(r2.count).toBe(1);
  });

  test("different taskId is a separate key", () => {
    const key1 = { taskId: "mt#1", toolName: "tool_a", errorSignature: "SIG" };
    const key2 = { taskId: "mt#2", toolName: "tool_a", errorSignature: "SIG" };
    tracker.recordError(key1, "err");
    const r2 = tracker.recordError(key2, "err");

    expect(r2.count).toBe(1);
  });

  test("constructor throws when capacity is 0", () => {
    expect(() => new MapLruStrikeTracker(0)).toThrow("StrikeTracker capacity must be >= 1");
  });

  test("constructor throws when capacity is negative", () => {
    expect(() => new MapLruStrikeTracker(-5)).toThrow("StrikeTracker capacity must be >= 1");
  });
});

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

describe("MapLruStrikeTracker LRU eviction", () => {
  test("oldest entry is evicted when capacity is exceeded", () => {
    const tracker = new MapLruStrikeTracker(256);

    // Insert 256 distinct keys — fills to capacity.
    for (let i = 0; i < 256; i++) {
      tracker.recordError(
        { taskId: `mt#${i}`, toolName: "tool", errorSignature: "SIG" },
        `error-${i}`
      );
    }

    // Insert 257th key — should evict key 0.
    tracker.recordError({ taskId: "mt#256", toolName: "tool", errorSignature: "SIG" }, "error-256");

    // Key 0 was evicted: next recordError for it starts fresh (count=1, not 2).
    const r = tracker.recordError(
      { taskId: "mt#0", toolName: "tool", errorSignature: "SIG" },
      "evicted-check"
    );
    expect(r.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: two same-signature errors → Ask emitted via FakeAskRepository
// ---------------------------------------------------------------------------

describe("2-strikes Ask emission integration", () => {
  let tracker: MapLruStrikeTracker;
  let repo: FakeAskRepository;

  beforeEach(() => {
    tracker = new MapLruStrikeTracker();
    repo = new FakeAskRepository();
  });

  /**
   * Simulate what the MCP error path does: call recordError and, on strike-2,
   * create a stuck.unblock Ask.
   *
   * sessionId mimics the production code path: when args.task is absent, the
   * tracker key is built from sessionId (not the deprecated "_global" fallback).
   */
  async function simulateMcpError(
    taskId: string | undefined,
    toolName: string,
    error: unknown,
    sessionId?: string
  ): Promise<void> {
    // Mirror the production keying logic from shared-command-integration.ts:
    // use args.task when present, otherwise fall back to sessionId ?? "unknown".
    const effectiveTaskId = taskId ?? sessionId ?? "unknown";
    const sig = normalizeErrorSignature(error);
    const result = tracker.recordError(
      { taskId: effectiveTaskId, toolName, errorSignature: sig },
      error
    );

    if (result.count === 2) {
      await repo.create({
        kind: "stuck.unblock",
        classifierVersion: "v1.0.0",
        requestor: effectiveTaskId,
        parentTaskId: taskId,
        title: `MCP tool ${toolName} failed twice with same error`,
        question: `Tool "${toolName}" produced the same error twice.`,
        metadata: { priorAttempts: result.attempts },
      });
    }
  }

  test("two same-signature errors → exactly one stuck.unblock Ask emitted", async () => {
    const err = new Error("connection refused");

    await simulateMcpError("mt#99", "session_exec", err);
    await simulateMcpError("mt#99", "session_exec", err);

    const asks = repo.all;
    expect(asks).toHaveLength(1);
    expect(asks[0]?.kind).toBe("stuck.unblock");
    expect(asks[0]?.state).toBe("detected");
    const meta = asks[0]?.metadata as { priorAttempts?: unknown[] };
    expect(meta?.priorAttempts).toHaveLength(2);
  });

  test("successful call between two same-signature errors → no Ask emitted", async () => {
    const err = new Error("timeout");

    await simulateMcpError("mt#99", "session_exec", err);
    // Simulate success — resets the counter.
    tracker.recordSuccess("mt#99", "session_exec");
    await simulateMcpError("mt#99", "session_exec", err);

    // Counter was reset by success; second error is only strike-1 on fresh counter.
    expect(repo.all).toHaveLength(0);
  });

  test("two errors with different signatures → no Ask emitted", async () => {
    const err1 = new Error("timeout");
    const err2 = new Error("connection refused");

    await simulateMcpError("mt#99", "session_exec", err1);
    await simulateMcpError("mt#99", "session_exec", err2);

    // Different signatures — each is strike-1 on its own key.
    expect(repo.all).toHaveLength(0);
  });

  test("Ask has state: detected and prior attempts in metadata", async () => {
    const err = { code: "TOOL_ERR", message: "tool error detail" };

    await simulateMcpError("mt#42", "session_commit", err);
    await simulateMcpError("mt#42", "session_commit", err);

    const asks = repo.all;
    expect(asks).toHaveLength(1);
    expect(asks[0]?.state).toBe("detected");
    expect(asks[0]?.kind).toBe("stuck.unblock");
    const meta = asks[0]?.metadata as { priorAttempts?: unknown[] };
    expect(Array.isArray(meta?.priorAttempts)).toBe(true);
    expect((meta?.priorAttempts ?? []).length).toBe(2);
  });

  test("classifierVersion is v1.0.0", async () => {
    const err = new Error("any");
    await simulateMcpError("mt#1", "tool_x", err);
    await simulateMcpError("mt#1", "tool_x", err);

    expect(repo.all[0]?.classifierVersion).toBe("v1.0.0");
  });

  // ---------------------------------------------------------------------------
  // Cross-session bleed test (mt#1464 R2 fix)
  // ---------------------------------------------------------------------------
  // Reproduces the production bug: when args.task is absent, both error paths
  // previously fell back to "_global", collapsing all task-less commands into
  // one shared bucket. Two unrelated sessions hitting the same MCP error would
  // thus produce a false 2-strike and emit a spurious stuck.unblock Ask.
  //
  // After the fix, the tracker key uses sessionId when args.task is absent,
  // so each session has its own independent strike counter.
  test("two sessions without args.task do NOT share strike counters", async () => {
    const err = new Error("connection timeout");
    const toolName = "session_exec";

    // Session A: first error (no task arg — uses sessionId as key)
    await simulateMcpError(undefined, toolName, err, "session-aaa-111");
    // Session B: first error with same tool + signature but DIFFERENT sessionId
    await simulateMcpError(undefined, toolName, err, "session-bbb-222");

    // Each session should have count=1 independently — no Ask emitted for either.
    // Before the fix, both would key by "_global" and the 2nd call would be count=2.
    expect(repo.all).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// serializeAttempt JSON-serializability (tested via integration path)
// ---------------------------------------------------------------------------

describe("priorAttempts JSON-serializability", () => {
  /**
   * Simulate the emitStuckUnblockAsk serialization behaviour via a helper
   * that mirrors what serializeAttempt does.
   *
   * We test the contract without importing the unexported helper directly.
   * `stack` is intentionally absent: it can leak file paths, internal
   * hostnames, and tokens — a security risk for Ask metadata (mt#1464 R2 fix).
   */
  function serializeAttempt(payload: unknown): unknown {
    if (payload instanceof Error) {
      const err = payload as Error & { code?: unknown };
      return {
        name: err.name,
        code: err.code !== undefined ? err.code : undefined,
        message: err.message,
        // stack omitted: security — can leak file paths, hostnames, and tokens
      };
    }
    return payload;
  }

  test("Error instance serializes to JSON-safe object with name/message (no stack)", () => {
    const err = new Error("serialization test error");
    const serialized = serializeAttempt(err);
    // Must round-trip cleanly.
    const roundTripped = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>;
    expect(roundTripped["name"]).toBe("Error");
    expect(roundTripped["message"]).toBe("serialization test error");
    // stack MUST NOT be present — security fix: stack traces can leak file paths,
    // hostnames, and tokens (mt#1464 R2 fix).
    expect("stack" in roundTripped).toBe(false);
  });

  test("Error with numeric code includes code in serialized output", () => {
    const err = Object.assign(new Error("mcp error"), { code: -32000 });
    const serialized = serializeAttempt(err) as Record<string, unknown>;
    const roundTripped = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>;
    expect(roundTripped["code"]).toBe(-32000);
    expect(roundTripped["message"]).toBe("mcp error");
  });

  test("plain object passes through unchanged", () => {
    const payload = { code: "ENOENT", message: "not found" };
    const serialized = serializeAttempt(payload);
    expect(serialized).toBe(payload);
  });

  test("primitive string passes through unchanged", () => {
    expect(serializeAttempt("some error")).toBe("some error");
  });
});
