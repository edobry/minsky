/**
 * Tests for the session.generate_prompt dispatch-time invocation writer (mt#2796).
 *
 * `session_generate_prompt` is the primary subagent-dispatch path (per the
 * Subagent Routing convention — "Always use session_generate_prompt"). Unlike
 * `tasks_dispatch` (which already wrote a pending `subagent_invocations` row
 * with `suggestedModel` at dispatch time, see dispatch-command.ts Step 5),
 * this command previously wrote no row at all — the only row for a
 * session_generate_prompt-then-Agent-tool dispatch was the SubagentStop
 * hook's orphan INSERT, with `suggested_model` left null forever.
 *
 * This suite verifies the new pending-row write: a `session.generate_prompt`
 * call records a `subagent_invocations` row carrying `suggestedModel` and
 * `agentType` from the generated prompt result, keyed by `subagentSessionId`
 * so the SubagentStop hook's later upsert can find and extend it.
 *
 * @see mt#2796 — this task
 * @see src/adapters/shared/commands/session/prompt-command.ts — implementation under test
 * @see src/adapters/shared/commands/tasks/dispatch-command.ts — the sibling Step 5 pattern
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createSessionGeneratePromptCommand } from "./prompt-command";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import type { SessionRecord } from "@minsky/domain/session/types";
import { SessionStatus } from "@minsky/domain/session/types";
import type { SessionCommandDependencies } from "./types";
import { SubagentDispatchTracker } from "../../../../mcp/subagent-dispatch-tracker";
import type { SubagentInvocationInput } from "../../../../mcp/subagent-dispatch-tracker";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const TASK_ID = "mt#2796";
const SESSION_ID = "prompt-command-test-session";

function buildSessionRecord(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "owner-repo",
    repoUrl: "https://github.com/owner/repo.git",
    createdAt: new Date().toISOString(),
    taskId: TASK_ID,
    status: SessionStatus.ACTIVE,
    lastActivityAt: new Date().toISOString(),
  };
}

function buildGetDeps(sessionDB: FakeSessionProvider): () => Promise<SessionCommandDependencies> {
  return async () =>
    ({
      sessionProvider: sessionDB,
    }) as unknown as SessionCommandDependencies;
}

/**
 * Minimal fake DB — only supports what `recordSubagentInvocation`'s INSERT
 * path needs: a SELECT that always resolves empty (so the upsert always
 * takes the INSERT branch, since the store starts empty) and an INSERT that
 * captures the inserted row via `onInsert`. No groupBy/orderBy/update
 * support — this test only exercises one dispatch-time write, not the
 * cadence-aggregation surface (covered by subagent-dispatch-tracker.test.ts).
 */
function makeMinimalFakeDb(onInsert: (input: SubagentInvocationInput) => void): PostgresJsDatabase {
  const selectChain = {
    from() {
      return selectChain;
    },
    where() {
      return selectChain;
    },
    limit() {
      return selectChain;
    },
    then(resolve: (v: unknown[]) => void, _reject: (e: unknown) => void): Promise<unknown> {
      return Promise.resolve([]).then(resolve);
    },
  };

  const db = {
    select() {
      return selectChain;
    },
    insert(_table: unknown) {
      return {
        values(input: SubagentInvocationInput) {
          onInsert(input);
          return Promise.resolve();
        },
      };
    },
  };

  return db as unknown as PostgresJsDatabase;
}

describe("session.generate_prompt dispatch-time invocation writer (mt#2796)", () => {
  let inserted: SubagentInvocationInput[];

  beforeEach(() => {
    inserted = [];
    SubagentDispatchTracker.resetForTest(makeMinimalFakeDb((input) => inserted.push(input)));
  });

  afterEach(() => {
    // Reset to a fresh no-op tracker so this suite doesn't bleed into others.
    SubagentDispatchTracker.resetForTest(makeMinimalFakeDb(() => undefined));
  });

  test("writes a pending invocation row carrying suggestedModel and agentType", async () => {
    const sessionDB = new FakeSessionProvider({ initialSessions: [buildSessionRecord()] });
    const command = createSessionGeneratePromptCommand(buildGetDeps(sessionDB));

    const result = (await command.execute(
      {
        task: TASK_ID,
        type: "implementation",
        instructions: "do the thing",
      },
      {}
    )) as { success: boolean; suggestedModel?: string; agentType?: string };

    expect(result.success).toBe(true);
    expect(inserted).toHaveLength(1);

    const row = inserted[0];
    expect(row).toBeDefined();
    expect(row?.taskId).toBe(TASK_ID);
    expect(row?.subagentSessionId).toBe(SESSION_ID);
    expect(row?.outcome).toBe("crashed-no-output");
    expect(row?.suggestedModel).toBe(result.suggestedModel ?? null);
    expect(row?.suggestedModel).toBeTruthy();
    expect(row?.agentType).toBe(result.agentType ?? "implementation");
  });

  test("does not block prompt generation when the tracker write fails", async () => {
    // A DB whose select() throws synchronously — recordSubagentInvocation's
    // own try/catch should swallow it, and this command's own try/catch is a
    // second layer; either way, execute() must still resolve successfully.
    const throwingDb = {
      select() {
        throw new Error("boom");
      },
      insert() {
        throw new Error("boom");
      },
    } as unknown as PostgresJsDatabase;
    SubagentDispatchTracker.resetForTest(throwingDb);

    const sessionDB = new FakeSessionProvider({ initialSessions: [buildSessionRecord()] });
    const command = createSessionGeneratePromptCommand(buildGetDeps(sessionDB));

    const result = (await command.execute(
      {
        task: TASK_ID,
        type: "implementation",
        instructions: "do the thing",
      },
      {}
    )) as { success: boolean };

    expect(result.success).toBe(true);
  });
});
