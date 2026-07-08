/**
 * Evidence-gate tests for tasks_dispatch (mt#2488).
 *
 * Verifies the tool-boundary evidence gate: a dispatch whose premise is not well-formed
 * is BLOCKED before any side effect; a dispatch with a well-formed premise passes the
 * gate. The deps are throwing stubs — on an env without native subagent support the gate
 * passes straight to the harness check (no dep touched); on an env WITH support it reaches
 * a stub. Either way the assertion is that the failure (if any) is NOT an evidence-gate
 * error, i.e. the gate let it through.
 *
 * This is environment-AGNOSTIC by construction (NOT environment-sensitive): the assertions
 * hold regardless of what `hasNativeSubagentSupport()` returns in this env. `mock.module`
 * is deliberately avoided — bun runs test files in one shared process, so a module mock of
 * harness-detection could leak into sibling test files that rely on the real implementation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTasksDispatchCommand } from "./dispatch-command";
import { ValidationError } from "@minsky/domain/errors";
import { FakeTaskService } from "@minsky/domain/tasks/fake-task-service";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import { FakePersistenceProvider } from "@minsky/domain/persistence/fake-persistence-provider";
import { SessionStatus } from "@minsky/domain/session/types";
import type { SessionRecord } from "@minsky/domain/session/types";
import { TASK_STATUS } from "@minsky/domain/tasks/taskConstants";

const throwingDep = () => {
  throw new Error("dispatch dependency should not be reached in this test");
};

function makeCommand() {
  return createTasksDispatchCommand(
    throwingDep as never,
    throwingDep as never,
    throwingDep as never,
    throwingDep as never
  );
}

const validPremise = {
  premiseClaim: "cold-start-migrate is red because of this PR's new init slug-stamping",
  premiseFalsifier: "check whether the same check is red on main and other open branches",
  premiseEvidence: "forge_check_runs_list <main-sha> shows it red on main too — not this PR",
};

const EVIDENCE_ERROR = /evidence argument|not well-formed/;

describe("tasks_dispatch evidence gate (mt#2488)", () => {
  test("blocks a dispatch with an absent premise", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({ title: "t", instructions: "i", type: "implementation" } as never)
    ).rejects.toThrow(ValidationError);
  });

  test("blocks a dispatch whose premise fields are empty", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        title: "t",
        instructions: "i",
        type: "implementation",
        premiseClaim: "",
        premiseFalsifier: "",
        premiseEvidence: "",
      } as never)
    ).rejects.toThrow(EVIDENCE_ERROR);
  });

  test("blocks a dispatch whose premise is below the substance floor", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        title: "t",
        instructions: "i",
        type: "implementation",
        premiseClaim: "ok",
        premiseFalsifier: "ok",
        premiseEvidence: "ok",
      } as never)
    ).rejects.toThrow(EVIDENCE_ERROR);
  });

  test("a well-formed premise passes the evidence gate", async () => {
    const cmd = makeCommand();
    let caught: unknown;
    let result: unknown;
    try {
      result = await cmd.execute({
        title: "t",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never);
    } catch (err) {
      caught = err;
    }
    // The gate let it through: any failure past it is a harness/dep concern, NOT an
    // evidence-gate ValidationError.
    if (caught !== undefined) {
      expect((caught as Error).message).not.toMatch(EVIDENCE_ERROR);
    } else {
      expect(result).toBeDefined();
    }
  });
});

/**
 * Mode-selection tests for the existing-taskId dispatch mode (mt#2657).
 *
 * `validateDispatchMode` runs right after the evidence gate and before the harness check, so —
 * like the evidence gate tests above — these assertions are deterministic regardless of what
 * `hasNativeSubagentSupport()` returns in this environment.
 */
const MODE_ERROR =
  /requires either `taskId`|are mutually exclusive|only applies to new-task creation/;

describe("tasks_dispatch mode selection (mt#2657)", () => {
  test("blocks when neither taskId nor title is provided", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never)
    ).rejects.toThrow(MODE_ERROR);
  });

  // R1 review fix (PR #1837 review 4651483333): both taskId and title were previously
  // accepted together — taskId silently won, ignoring title. Now rejected outright.
  test("blocks when both taskId and title are provided", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        taskId: "mt#2657",
        title: "t",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never)
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("blocks when both taskId and parentTaskId are provided", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        taskId: "mt#2657",
        parentTaskId: "mt#1",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never)
    ).rejects.toThrow(MODE_ERROR);
  });

  // R1 review fix (PR #1837 review 4651474893): description was previously silently
  // ignored in existing-task mode, risking operator confusion. Now rejected outright.
  test("blocks when both taskId and description are provided", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        taskId: "mt#2657",
        description: "spec content",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never)
    ).rejects.toThrow(/only applies to new-task creation/);
  });

  test("title-only (no taskId) passes mode selection unaffected (backward compat)", async () => {
    const cmd = makeCommand();
    let caught: unknown;
    let result: unknown;
    try {
      result = await cmd.execute({
        title: "t",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never);
    } catch (err) {
      caught = err;
    }
    if (caught !== undefined) {
      expect((caught as Error).message).not.toMatch(MODE_ERROR);
    } else {
      expect(result).toBeDefined();
    }
  });

  test("taskId-only (existing-task mode) passes mode selection", async () => {
    const cmd = makeCommand();
    let caught: unknown;
    let result: unknown;
    try {
      result = await cmd.execute({
        taskId: "mt#2657",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never);
    } catch (err) {
      caught = err;
    }
    // The mode gate let it through: any failure past it is a harness/dep concern (the deps are
    // throwing stubs), NOT a mode-selection ValidationError.
    if (caught !== undefined) {
      expect((caught as Error).message).not.toMatch(MODE_ERROR);
    } else {
      expect(result).toBeDefined();
    }
  });
});

/**
 * Type-default and crash-safety (resume) tests for tasks_dispatch existing-task mode (mt#2695).
 *
 * Root cause 1 (type default): the MCP/CLI parameter layers only apply a default from the
 * sibling `defaultValue` field on a `CommandParameterDefinition` — the Zod schema's own
 * `.default(...)` on the `type` param is never consulted by either boundary (see the comment on
 * the `type` param def in dispatch-command.ts). Omitting `type` used to crash at
 * packages/domain/src/session/prompt-generation.ts:207 (`params.type.charAt(0)`).
 *
 * Root cause 2 (crash-safety): a dispatch that crashed after the status walk + session_start but
 * before prompt generation completed left the task IN-PROGRESS with a stranded, commit-free
 * (`SessionStatus.CREATED`) session. A repeat dispatch now detects that exact signature and
 * RESUMES against the existing session instead of refusing.
 *
 * These tests drive `execute()` through a REAL status read (via FakeTaskService) and a REAL
 * resume-detection lookup (via FakeSessionProvider) — fully hermetic, no filesystem/git I/O. The
 * resume path doubles as the vehicle to reach Step 4 (prompt generation, where `type` is
 * actually consumed): Step 3's fresh-session-creation branch calls the REAL
 * `createGitService()`/`SessionService.start()` pipeline, which is not injectable here and would
 * do real git I/O — unsuitable for a hermetic unit test (this mirrors why the mode-selection
 * tests above use throwing stubs and never reach that branch either).
 *
 * `hasNativeSubagentSupport()` is forced to `true` via `CLAUDECODE` for this block since a
 * `success: true` assertion — unlike the environment-agnostic "not this error" assertions above —
 * requires the pipeline to actually run to completion regardless of the host environment.
 */
describe("tasks_dispatch existing-task mode: type default + crash-safety resume (mt#2695)", () => {
  let savedClaudeCode: string | undefined;

  beforeEach(() => {
    savedClaudeCode = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
  });

  afterEach(() => {
    if (savedClaudeCode === undefined) {
      delete process.env.CLAUDECODE;
    } else {
      process.env.CLAUDECODE = savedClaudeCode;
    }
  });

  function makeResumeFixtures(
    taskId: string,
    taskStatus: string,
    session?: Partial<SessionRecord>
  ): {
    taskService: FakeTaskService;
    sessionProvider: FakeSessionProvider;
    sessionRecord?: SessionRecord;
  } {
    const taskService = new FakeTaskService({
      initialTasks: [{ id: taskId, title: "mt#2695 fixture task", status: taskStatus }],
    });
    const sessionRecord: SessionRecord | undefined = session
      ? {
          sessionId: `task-${taskId}`,
          repoName: "minsky",
          repoUrl: "https://github.com/edobry/minsky.git",
          createdAt: new Date().toISOString(),
          taskId,
          status: SessionStatus.CREATED,
          ...session,
        }
      : undefined;
    const sessionProvider = new FakeSessionProvider({
      initialSessions: sessionRecord ? [sessionRecord] : [],
    });
    return { taskService, sessionProvider, sessionRecord };
  }

  function makeCommandWithFixtures(
    taskService: FakeTaskService,
    sessionProvider: FakeSessionProvider
  ) {
    return createTasksDispatchCommand(
      () => new FakePersistenceProvider(),
      async () => sessionProvider,
      throwingDep as never, // getTaskGraphService — never touched (no parentTaskId in these tests)
      () => taskService
    );
  }

  test("t1: omitted `type` defaults to implementation instead of crashing", async () => {
    const { taskService, sessionProvider } = makeResumeFixtures(
      "mt#9101",
      TASK_STATUS.IN_PROGRESS,
      {}
    );
    const cmd = makeCommandWithFixtures(taskService, sessionProvider);

    const result = (await cmd.execute({
      taskId: "mt#9101",
      instructions: "do the thing",
      ...validPremise,
    } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.prompt as string).toContain("Implementation work");
  });

  test("t2: a repeat dispatch resumes a stranded (CREATED, commit-free) session instead of refusing", async () => {
    const { taskService, sessionProvider, sessionRecord } = makeResumeFixtures(
      "mt#9102",
      TASK_STATUS.IN_PROGRESS,
      {}
    );
    const cmd = makeCommandWithFixtures(taskService, sessionProvider);

    const result = (await cmd.execute({
      taskId: "mt#9102",
      instructions: "do the thing",
      type: "implementation",
      ...validPremise,
    } as never)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.resumed).toBe(true);
    expect(result.sessionId).toBe(sessionRecord?.sessionId);
    expect(result.statusWalk).toEqual([]);
    // No new session was created — the store still holds exactly the one stranded session.
    expect((await sessionProvider.listSessions()).length).toBe(1);
  });

  test("IN-PROGRESS with an ACTIVE (committed-work) session is refused, not resumed", async () => {
    const { taskService, sessionProvider } = makeResumeFixtures(
      "mt#9103",
      TASK_STATUS.IN_PROGRESS,
      { status: SessionStatus.ACTIVE, commitCount: 1 }
    );
    const cmd = makeCommandWithFixtures(taskService, sessionProvider);

    const result = (await cmd.execute({
      taskId: "mt#9103",
      instructions: "do the thing",
      type: "implementation",
      ...validPremise,
    } as never)) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error as string).toMatch(/committed work/);
  });

  test("IN-PROGRESS with no session at all is refused with PLANNING-path guidance, not a bare READY suggestion", async () => {
    const { taskService, sessionProvider } = makeResumeFixtures("mt#9104", TASK_STATUS.IN_PROGRESS);
    const cmd = makeCommandWithFixtures(taskService, sessionProvider);

    const result = (await cmd.execute({
      taskId: "mt#9104",
      instructions: "do the thing",
      type: "implementation",
      ...validPremise,
    } as never)) as Record<string, unknown>;

    expect(result.success).toBe(false);
    const error = result.error as string;
    expect(error).toMatch(/via PLANNING/);
    expect(error).toMatch(/IN-PROGRESS -> READY is NOT a valid/);
  });
});
