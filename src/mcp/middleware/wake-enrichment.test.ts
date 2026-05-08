/**
 * Tests for the wake-enrichment middleware (mt#1661 v0).
 *
 * Covers:
 *   - Allowlist gate (non-allowlisted tools return null)
 *   - Resolver outcomes (success / null / throws) and their telemetry shape
 *   - Drain delivery + idempotency (second call returns null)
 *   - Failure tolerance (drain failure returns null, doesn't throw)
 *   - Block format (envelope shape, payload preservation)
 */

import { describe, expect, test } from "bun:test";
import {
  enrichWakeResponse,
  shouldEnrichWake,
  type SessionResolver,
  type WakeServiceSurface,
} from "./wake-enrichment";
import { FakeWakePendingRepository } from "../../domain/ask/wake-pending-repository";
import type { WakeSignalPayload } from "../../domain/ask/wake-on-respond";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ALLOWLISTED_TOOL = "tasks.get";
const NOT_ALLOWLISTED_TOOL = "git_log";

const PAYLOAD_A: WakeSignalPayload = {
  askId: "ask-a",
  parentSessionId: "session-1",
  parentTaskId: "mt#1661",
  reviewBody: "review A",
  reviewState: "APPROVED",
  reviewAuthor: "minsky-reviewer[bot]",
  prNumber: 11,
};

const PAYLOAD_B: WakeSignalPayload = {
  askId: "ask-b",
  parentSessionId: "session-1",
  parentTaskId: "mt#1661",
  reviewBody: "review B",
  reviewState: "CHANGES_REQUESTED",
  reviewAuthor: "minsky-reviewer[bot]",
  prNumber: 11,
};

function resolverReturning(value: string | null): SessionResolver {
  return {
    async resolveParentSessionId(): Promise<string | null> {
      return value;
    },
  };
}

function resolverThrowing(message: string): SessionResolver {
  return {
    async resolveParentSessionId(): Promise<string | null> {
      throw new Error(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Allowlist gate
// ---------------------------------------------------------------------------

describe("shouldEnrichWake", () => {
  test("returns true for allowlisted tool", () => {
    expect(shouldEnrichWake(ALLOWLISTED_TOOL)).toBe(true);
  });

  test("returns false for non-allowlisted tool", () => {
    expect(shouldEnrichWake(NOT_ALLOWLISTED_TOOL)).toBe(false);
    expect(shouldEnrichWake("session.get")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enrichWakeResponse
// ---------------------------------------------------------------------------

describe("enrichWakeResponse", () => {
  test("returns null for non-allowlisted tool (no service call)", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(PAYLOAD_A);
    const block = await enrichWakeResponse(
      NOT_ALLOWLISTED_TOOL,
      { session: "session-1" },
      repo,
      resolverReturning("session-1")
    );
    expect(block).toBeNull();
    // Row stays undelivered (the middleware short-circuited before draining).
    expect(repo.listAll().every((r) => r.drainedAt === null)).toBe(true);
  });

  test("returns null when wakeService is unset", async () => {
    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "session-1" },
      undefined,
      resolverReturning("session-1")
    );
    expect(block).toBeNull();
  });

  test("returns null when sessionResolver is unset", async () => {
    const repo = new FakeWakePendingRepository();
    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "session-1" },
      repo,
      undefined
    );
    expect(block).toBeNull();
  });

  test("returns null when resolver returns null (no_session_id case)", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(PAYLOAD_A);
    const block = await enrichWakeResponse(ALLOWLISTED_TOOL, {}, repo, resolverReturning(null));
    expect(block).toBeNull();
    // The wake row stays undelivered — no session means no addressable target.
    expect(repo.listAll()[0]?.drainedAt).toBeNull();
  });

  test("returns null when resolver throws (does not break the tool call)", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(PAYLOAD_A);
    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "bad" },
      repo,
      resolverThrowing("resolver crashed")
    );
    expect(block).toBeNull();
    expect(repo.listAll()[0]?.drainedAt).toBeNull();
  });

  test("returns null when session resolves but no pending wakes (silent no-op)", async () => {
    const repo = new FakeWakePendingRepository();
    // No wakes inserted.
    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "session-1" },
      repo,
      resolverReturning("session-1")
    );
    expect(block).toBeNull();
  });

  test("delivers a content block when wakes are pending and marks rows drained", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(PAYLOAD_A);
    await repo.insert(PAYLOAD_B);
    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "session-1" },
      repo,
      resolverReturning("session-1")
    );

    expect(block).not.toBeNull();
    expect(block?.type).toBe("text");
    // Envelope identifies the tool, session, and count.
    expect(block?.text).toContain(
      `<wake-events tool="${ALLOWLISTED_TOOL}" session="session-1" count="2">`
    );
    expect(block?.text).toContain("</wake-events>");
    // Both payloads are present as JSON lines.
    expect(block?.text).toContain('"askId":"ask-a"');
    expect(block?.text).toContain('"askId":"ask-b"');
    // Rows are marked drained with the tool name.
    const all = repo.listAll();
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.drainedAt !== null)).toBe(true);
    expect(all.every((r) => r.drainedForTool === ALLOWLISTED_TOOL)).toBe(true);
  });

  test("idempotent: a second call for the same session returns null (no re-delivery)", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(PAYLOAD_A);

    const first = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "session-1" },
      repo,
      resolverReturning("session-1")
    );
    expect(first).not.toBeNull();

    const second = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "session-1" },
      repo,
      resolverReturning("session-1")
    );
    expect(second).toBeNull();
  });

  test("only drains wakes for the calling session (cross-session isolation)", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(PAYLOAD_A); // session-1
    const otherSessionPayload: WakeSignalPayload = {
      ...PAYLOAD_B,
      askId: "ask-other",
      parentSessionId: "session-2",
    };
    await repo.insert(otherSessionPayload);

    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "session-1" },
      repo,
      resolverReturning("session-1")
    );

    expect(block).not.toBeNull();
    expect(block?.text).toContain('"askId":"ask-a"');
    expect(block?.text).not.toContain('"askId":"ask-other"');

    // The session-2 row stays undelivered.
    const all = repo.listAll();
    const session2Row = all.find((r) => r.parentSessionId === "session-2");
    expect(session2Row?.drainedAt).toBeNull();
  });

  test("returns null when drainBySession throws (does not break the tool call)", async () => {
    const failingService: WakeServiceSurface = {
      async drainBySession(): Promise<WakeSignalPayload[]> {
        throw new Error("DB query failed");
      },
    };
    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "session-1" },
      failingService,
      resolverReturning("session-1")
    );
    expect(block).toBeNull();
  });
});
