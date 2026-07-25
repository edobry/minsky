/**
 * Tests for the stamp-session-creator-link hook's id resolvers.
 *
 * The hook proper (entry point under `import.meta.main`) reads stdin and
 * writes to Postgres; the DB path is covered by
 * `scripts/verify-session-creator-link.ts` against the live schema. What is
 * tested here is the part that had the bug in every prior instance of this
 * family: WHICH id comes from WHERE.
 *
 * Mirrors stamp-pr-author-link.test.ts's shape and case list.
 *
 * Reference: mt#3120
 */

import { describe, it, expect } from "bun:test";
import {
  resolveConversationId,
  resolveWorkspaceSessionId,
  resolveTaskId,
  lookupWorkspaceSessionIdByTask,
  raceDeadline,
} from "./stamp-session-creator-link";
import type { ToolHookInput } from "./types";

const CONVERSATION_ID = "a1b2c3d4-1111-4222-8333-000000000001";
const WORKSPACE_ID = "e5f6a7b8-2222-4333-8444-000000000002";

function makeInput(overrides: Partial<ToolHookInput>): ToolHookInput {
  return {
    session_id: CONVERSATION_ID,
    cwd: "/tmp/repo",
    hook_event_name: "PostToolUse",
    tool_name: "mcp__minsky__session_start",
    tool_input: {},
    ...overrides,
  };
}

describe("resolveConversationId", () => {
  it("reads the harness-supplied session_id", () => {
    expect(resolveConversationId(makeInput({}))).toBe(CONVERSATION_ID);
  });

  it("never takes the workspace id from the tool payload", () => {
    // The bug this whole task family exists to prevent: the workspace id is
    // right there in the payload and is the wrong keyspace.
    const r = resolveConversationId(makeInput({ tool_input: { sessionId: WORKSPACE_ID } }));
    expect(r).toBe(CONVERSATION_ID);
    expect(r).not.toBe(WORKSPACE_ID);
  });

  it("returns null when the harness supplied no session_id", () => {
    expect(
      resolveConversationId(makeInput({ session_id: undefined as unknown as string }))
    ).toBeNull();
  });

  it("returns null for an empty session_id rather than linking on an empty key", () => {
    expect(resolveConversationId(makeInput({ session_id: "" }))).toBeNull();
  });
});

describe("resolveWorkspaceSessionId", () => {
  it("reads tool_input.sessionId (explicit caller-supplied id)", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { sessionId: WORKSPACE_ID } }))).toBe(
      WORKSPACE_ID
    );
  });

  it("falls back to tool_input.session", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { session: WORKSPACE_ID } }))).toBe(
      WORKSPACE_ID
    );
  });

  it("falls back to tool_result.session.sessionId — the common case (no explicit id)", () => {
    const r = resolveWorkspaceSessionId(
      makeInput({
        tool_input: { task: "mt#3120" },
        tool_result: { success: true, session: { sessionId: WORKSPACE_ID, taskId: "mt#3120" } },
      })
    );
    expect(r).toBe(WORKSPACE_ID);
  });

  it("falls back to a top-level tool_result.sessionId", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_result: { sessionId: WORKSPACE_ID } }))).toBe(
      WORKSPACE_ID
    );
  });

  it("never returns the conversation id", () => {
    // The mirror of the check above: the harness id must not leak into the
    // workspace slot either, or the link would point a workspace at itself.
    const r = resolveWorkspaceSessionId(makeInput({ tool_input: {} }));
    expect(r).not.toBe(CONVERSATION_ID);
    expect(r).toBeNull();
  });

  it("ignores non-string and empty payload values", () => {
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { sessionId: 42 } }))).toBeNull();
    expect(resolveWorkspaceSessionId(makeInput({ tool_input: { sessionId: "" } }))).toBeNull();
    expect(
      resolveWorkspaceSessionId(makeInput({ tool_result: { session: "not-an-object" } }))
    ).toBeNull();
  });

  it("returns null for a failed call whose result carries no session", () => {
    // A failed session_start has no workspace to link — skipping is correct,
    // but it must be a NAMED skip (the hook logs the reason), not silent.
    const r = resolveWorkspaceSessionId(
      makeInput({ tool_input: { task: "mt#3120" }, tool_result: { success: false } })
    );
    expect(r).toBeNull();
  });
});

describe("the real harness payload (mt#3182 regression)", () => {
  /**
   * The payload shape production actually delivers: `tool_input` carries the
   * task, and there is NO `tool_result` at all. Every test above that resolves
   * a workspace id hand-BUILDS a `tool_result`, which is exactly why the suite
   * stayed green while the hook wrote 0 rows against 235 sessions.
   *
   * This is the assertion that fails if anyone reinstates payload-only
   * resolution: it pins that the payload route yields NOTHING here, so the
   * task-lookup route is load-bearing rather than decorative.
   */
  const realisticInput = makeInput({ tool_input: { task: "mt#3182" } });

  it("yields no workspace id from the payload — the documented production case", () => {
    expect(resolveWorkspaceSessionId(realisticInput)).toBeNull();
  });

  it("still yields the conversation id and the task id, the two ids that ARE present", () => {
    expect(resolveConversationId(realisticInput)).toBe(CONVERSATION_ID);
    expect(resolveTaskId(realisticInput)).toBe("mt#3182");
  });
});

describe("resolveTaskId", () => {
  it("reads the `task` alias the tool declares", () => {
    expect(resolveTaskId(makeInput({ tool_input: { task: "mt#3182" } }))).toBe("mt#3182");
  });

  it("reads the canonical `taskId` and prefers it over the alias", () => {
    expect(resolveTaskId(makeInput({ tool_input: { taskId: "mt#1" } }))).toBe("mt#1");
    expect(resolveTaskId(makeInput({ tool_input: { taskId: "mt#1", task: "mt#2" } }))).toBe("mt#1");
  });

  it("returns null for a taskless session_start", () => {
    expect(resolveTaskId(makeInput({ tool_input: { repo: "/tmp/repo" } }))).toBeNull();
  });

  it("ignores non-string and empty values", () => {
    expect(resolveTaskId(makeInput({ tool_input: { task: 42 } }))).toBeNull();
    expect(resolveTaskId(makeInput({ tool_input: { task: "" } }))).toBeNull();
  });
});

describe("lookupWorkspaceSessionIdByTask", () => {
  const TABLE = { sessionId: "col:session", taskId: "col:task_id", createdAt: "col:created_at" };
  const OPS = {
    eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
    desc: (a: unknown) => ({ desc: a }),
  };

  function stubDb(rows: unknown[]) {
    const calls: { where?: unknown; orderBy?: unknown; limit?: number } = {};
    const db = {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => {
            calls.where = cond;
            return {
              orderBy: (order: unknown) => {
                calls.orderBy = order;
                return {
                  limit: async (n: number) => {
                    calls.limit = n;
                    return rows;
                  },
                };
              },
            };
          },
        }),
      }),
    };
    return { db, calls };
  }

  it("returns the newest session id for the task", async () => {
    const { db } = stubDb([{ sessionId: WORKSPACE_ID }]);
    await expect(lookupWorkspaceSessionIdByTask(db, TABLE, OPS, "mt#3182")).resolves.toBe(
      WORKSPACE_ID
    );
  });

  it("filters on the task id and orders newest-first, taking one row", async () => {
    // Pins the query shape: without the desc(createdAt) ordering a task whose
    // session was deleted and recreated would resolve to the dead one.
    const { db, calls } = stubDb([{ sessionId: WORKSPACE_ID }]);
    await lookupWorkspaceSessionIdByTask(db, TABLE, OPS, "mt#3182");
    expect(calls.where).toEqual({ eq: ["col:task_id", "mt#3182"] });
    expect(calls.orderBy).toEqual({ desc: "col:created_at" });
    expect(calls.limit).toBe(1);
  });

  it("returns null when no session row exists for the task", async () => {
    const { db } = stubDb([]);
    await expect(lookupWorkspaceSessionIdByTask(db, TABLE, OPS, "mt#3182")).resolves.toBeNull();
  });

  it("is covered by the shared deadline, so a hung query cannot stall PostToolUse", async () => {
    // PR #2290 R1 (BLOCKING): the deadline originally wrapped only the link
    // write, leaving this SELECT unbounded. A hung query would then hold
    // PostToolUse open until the harness's own 20s timeout killed the hook.
    const neverResolves = new Promise<string | null>(() => {});
    await expect(raceDeadline(neverResolves, 20)).resolves.toBe("deadline");
  });

  it("returns null on a row missing or mistyping sessionId rather than linking on junk", async () => {
    const { db: d1 } = stubDb([{}]);
    await expect(lookupWorkspaceSessionIdByTask(d1, TABLE, OPS, "mt#3182")).resolves.toBeNull();
    const { db: d2 } = stubDb([{ sessionId: 42 }]);
    await expect(lookupWorkspaceSessionIdByTask(d2, TABLE, OPS, "mt#3182")).resolves.toBeNull();
    const { db: d3 } = stubDb([{ sessionId: "" }]);
    await expect(lookupWorkspaceSessionIdByTask(d3, TABLE, OPS, "mt#3182")).resolves.toBeNull();
  });
});
