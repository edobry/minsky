/**
 * StrikeTracker unit tests — mt#1464.
 *
 * Covers:
 *   - Two same-signature errors on same (taskId, toolName) → exactly one stuck.unblock Ask
 *   - Successful call between two same-signature errors → no Ask (counter resets)
 *   - Two errors with different signatures on same (taskId, toolName) → no Ask
 *   - LRU eviction: insert 257 distinct keys, oldest is evicted
 *   - normalizeErrorSignature: code field, message field, string fallback
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
   */
  async function simulateMcpError(taskId: string, toolName: string, error: unknown): Promise<void> {
    const sig = normalizeErrorSignature(error);
    const result = tracker.recordError({ taskId, toolName, errorSignature: sig }, error);

    if (result.count === 2) {
      await repo.create({
        kind: "stuck.unblock",
        classifierVersion: "v1.0.0",
        requestor: taskId,
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
});
