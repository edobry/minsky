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
  DEADLINE_EXCEEDED,
  enrichWakeResponse,
  raceEnrichmentDeadline,
  shouldEnrichWake,
  type SessionResolver,
  type WakeServiceSurface,
} from "./wake-enrichment";
import { FakeWakePendingRepository } from "@minsky/domain/ask/wake-pending-repository";
import type { WakeSignalPayload } from "@minsky/domain/ask/wake-on-respond";

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
// Conversation-keyed path (mt#4476) — the seam SC1 depends on
// ---------------------------------------------------------------------------

const AGENT_ID = "com.anthropic.claude-code:conv:c8fc3ca9-c3d6-4916-bbfe-99917f4ae596";

const ANSWERED_ASK: WakeSignalPayload = {
  kind: "ask.answered",
  askId: "ask-answered",
  agentId: AGENT_ID,
  parentTaskId: "mt#4476",
  reviewBody: "yes — ship it",
  reviewState: "responded",
  reviewAuthor: "operator",
  prNumber: 0,
};

describe("conversation-keyed delivery (mt#4476)", () => {
  test("delivers on a tool that is NOT on the session allowlist", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(ANSWERED_ASK);

    const block = await enrichWakeResponse(
      // A tool with no session/task args at all, and not on the allowlist. Under the
      // v0 conjunction this call delivered nothing — which is why an agent running a
      // long turn never learned its ask had been answered.
      NOT_ALLOWLISTED_TOOL,
      {},
      repo,
      undefined,
      { callerAgentId: AGENT_ID }
    );

    expect(block).not.toBeNull();
    expect(block?.text).toContain("ask-answered");
    expect(block?.text).toContain("yes — ship it");
  });

  test("second call delivers nothing — drain is idempotent on this key too", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(ANSWERED_ASK);

    await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, repo, undefined, {
      callerAgentId: AGENT_ID,
    });
    const second = await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, repo, undefined, {
      callerAgentId: AGENT_ID,
    });

    expect(second).toBeNull();
  });

  test("a DIFFERENT conversation does not receive it", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(ANSWERED_ASK);

    const block = await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, repo, undefined, {
      callerAgentId: "com.anthropic.claude-code:conv:99999999-9999-4999-8999-999999999999",
    });

    // The isolation the whole design rests on. If this ever passes a wake to the
    // wrong conversation, the key is not conversation-scoped — which is exactly what
    // an ADR-006 Layer 1 process hash would be, and why the server withholds one.
    expect(block).toBeNull();
  });

  test("no caller identity means no conversation-keyed drain at all", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(ANSWERED_ASK);

    const block = await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, repo, undefined, {});

    expect(block).toBeNull();
    // Still undrained — a call that cannot name a conversation must not consume
    // another conversation's pending wake.
    expect(repo.listAll().every((r) => r.drainedAt === null)).toBe(true);
  });

  test("a failure on the agent key does not suppress the session key", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(PAYLOAD_A);
    const halfFailing: WakeServiceSurface = {
      drainBySession: (s, t) => repo.drainBySession(s, t),
      async drainByAgent(): Promise<WakeSignalPayload[]> {
        throw new Error("agent drain failed");
      },
    };

    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      {},
      halfFailing,
      resolverReturning("session-1"),
      {
        callerAgentId: AGENT_ID,
      }
    );

    // The two keys are independent lookups; one failing is not a reason to withhold
    // what the other found.
    expect(block).not.toBeNull();
    expect(block?.text).toContain("ask-a");
  });
});

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
      async drainByAgent(): Promise<WakeSignalPayload[]> {
        return [];
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

// ---------------------------------------------------------------------------
// Deadline on the awaited drain (mt#4526)
// ---------------------------------------------------------------------------

/** A drain that never settles — the hang the deadline exists to bound. */
function hangingService(): WakeServiceSurface {
  return {
    drainBySession: () => new Promise<WakeSignalPayload[]>(() => {}),
    drainByAgent: () => new Promise<WakeSignalPayload[]>(() => {}),
  };
}

/**
 * A drain that settles LATE, after the deadline has already fired — the case that
 * distinguishes "bounded" from "bounded without losing anything". The returned
 * `settle` resolves the pending drain on demand so the test controls the ordering
 * instead of racing a real timer.
 */
function lateSettlingService(payloads: WakeSignalPayload[]): {
  service: WakeServiceSurface;
  settle: () => void;
} {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const drain = async (): Promise<WakeSignalPayload[]> => {
    await gate;
    return payloads;
  };
  return {
    service: { drainBySession: drain, drainByAgent: drain },
    settle: () => release?.(),
  };
}

describe("raceEnrichmentDeadline", () => {
  test("returns the work's value when it finishes inside the budget", async () => {
    const result = await raceEnrichmentDeadline(Promise.resolve("done"), 1000);
    expect(result).toBe("done");
  });

  test("returns DEADLINE_EXCEEDED when the budget elapses first", async () => {
    const result = await raceEnrichmentDeadline(new Promise<string>(() => {}), 5);
    expect(result).toBe(DEADLINE_EXCEEDED);
  });

  test("propagates a rejection that lands inside the budget", async () => {
    const boom = Promise.reject(new Error("drain failed"));
    await expect(raceEnrichmentDeadline(boom, 1000)).rejects.toThrow("drain failed");
  });
});

describe("enrichWakeResponse deadline (mt#4526)", () => {
  test("a never-settling conversation-keyed drain returns null within the bound", async () => {
    const startedAt = performance.now();
    const block = await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, hangingService(), undefined, {
      callerAgentId: AGENT_ID,
      deadlineMs: 20,
    });
    const elapsedMs = performance.now() - startedAt;

    // Fail-open: the tool call proceeds without the block rather than hanging.
    expect(block).toBeNull();
    // Bounded: generous upper bound so the assertion is about the deadline firing at
    // all, not about scheduler precision on a loaded machine.
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("a never-settling session-keyed drain returns null within the bound", async () => {
    const startedAt = performance.now();
    const block = await enrichWakeResponse(
      ALLOWLISTED_TOOL,
      { session: "session-1" },
      hangingService(),
      resolverReturning("session-1"),
      { deadlineMs: 20 }
    );
    const elapsedMs = performance.now() - startedAt;

    expect(block).toBeNull();
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("reports the payloads an abandoned drain took with it", async () => {
    // The drain marks rows delivered as it reads them, so a drain we stopped waiting
    // for can still commit — stamping wakes nobody rendered. mt#4517 owns closing that;
    // this asserts the loss is REPORTED rather than silent.
    const { service, settle } = lateSettlingService([ANSWERED_ASK]);
    const dropped: Array<{ key: string; droppedCount: number; askIds: string[] }> = [];

    const block = await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, service, undefined, {
      callerAgentId: AGENT_ID,
      deadlineMs: 5,
      onDroppedAfterTimeout: (info) => dropped.push(info),
    });
    expect(block).toBeNull();
    expect(dropped).toHaveLength(0); // nothing lost yet — the drain has not settled

    settle();
    await Promise.resolve();
    await Promise.resolve();

    expect(dropped).toEqual([{ key: "agent", droppedCount: 1, askIds: ["ask-answered"] }]);
  });

  test("does not report a drop when the abandoned drain resolves empty", async () => {
    const { service, settle } = lateSettlingService([]);
    const dropped: unknown[] = [];

    await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, service, undefined, {
      callerAgentId: AGENT_ID,
      deadlineMs: 5,
      onDroppedAfterTimeout: (info) => dropped.push(info),
    });

    settle();
    await Promise.resolve();
    await Promise.resolve();

    expect(dropped).toHaveLength(0);
  });

  test("an over-budget payload stays pending instead of being consumed (mt#4517 SC1)", async () => {
    // Measured, not estimated: an ANSWERED_ASK line is 238 chars of JSON and the
    // envelope reserves 134, so a 620-char budget leaves 486 of body — exactly two
    // lines (2x239=478 fits, 3x239=717 does not).
    const repo = new FakeWakePendingRepository();
    for (const askId of ["ask-1", "ask-2", "ask-3"]) {
      await repo.insert({ ...ANSWERED_ASK, askId });
    }

    const block = await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, repo, undefined, {
      callerAgentId: AGENT_ID,
      charBudget: 620,
    });
    expect(block).not.toBeNull();

    const delivered = repo.listAll().filter((r) => r.drainedAt !== null);
    const stillPending = repo.listAll().filter((r) => r.drainedAt === null);

    // The point of the task: what was not rendered was NOT marked.
    expect(delivered.length).toBeGreaterThan(0);
    expect(stillPending.length).toBeGreaterThan(0);
    expect(delivered.length + stillPending.length).toBe(3);
    for (const row of delivered) {
      expect(block?.text).toContain(row.askId);
    }
    for (const row of stillPending) {
      expect(block?.text).not.toContain(row.askId);
    }
  });

  test("every payload is eventually delivered across successive calls (mt#4517 SC2)", async () => {
    const repo = new FakeWakePendingRepository();
    const askIds = ["ask-1", "ask-2", "ask-3", "ask-4", "ask-5"];
    for (const askId of askIds) {
      await repo.insert({ ...ANSWERED_ASK, askId });
    }

    const seen = new Set<string>();
    // Bounded so a non-converging implementation fails instead of looping forever.
    for (let call = 0; call < 10; call++) {
      const block = await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, repo, undefined, {
        callerAgentId: AGENT_ID,
        charBudget: 620, // two payloads per call, so five take three calls
      });
      if (block === null) break;
      for (const askId of askIds) {
        if (block.text.includes(`"askId":"${askId}"`)) seen.add(askId);
      }
    }

    expect([...seen].sort()).toEqual(askIds);
    expect(repo.listAll().filter((r) => r.drainedAt === null)).toHaveLength(0);
  });

  test("a budget too small for even one payload releases everything (mt#4517)", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(ANSWERED_ASK);

    const block = await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, repo, undefined, {
      callerAgentId: AGENT_ID,
      charBudget: 120, // smaller than the envelope alone
    });

    expect(block).toBeNull();
    // Nothing rendered, so nothing may be marked — the row must survive for a later call.
    expect(repo.listAll().every((r) => r.drainedAt === null)).toBe(true);
  });

  test("control: a drain inside the budget still delivers (mt#4476 SC1 unregressed)", async () => {
    const repo = new FakeWakePendingRepository();
    await repo.insert(ANSWERED_ASK);

    const block = await enrichWakeResponse(NOT_ALLOWLISTED_TOOL, {}, repo, undefined, {
      callerAgentId: AGENT_ID,
      deadlineMs: 2000,
    });

    expect(block).not.toBeNull();
    expect(block?.text).toContain("ask-answered");
  });
});
