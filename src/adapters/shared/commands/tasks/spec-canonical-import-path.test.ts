/**
 * Regression test for mt#3194: exercises `getTaskSpecContentFromParams` via the
 * EXACT import path the live CLI/MCP `tasks.spec.get` command uses —
 * `spec-command.ts`'s `import { getTaskSpecContentFromParams } from
 * "@minsky/domain/tasks"` — not the `taskCommands.ts` barrel
 * (`packages/domain/src/tasks/taskCommands.ts`) that historically carried the
 * bulk of the existing test coverage for the sibling copy in
 * `tasks/commands/query-commands.ts`.
 *
 * Before mt#3194, `packages/domain/src/tasks.ts`'s `getTaskSpecContentFromParams`
 * called `taskService.getTaskSpecContent(taskId)` with a SINGLE argument and
 * never forwarded `section` — so `tasks spec --section` / `tasks_spec_get
 * section:` silently ignored the filter and returned the whole spec on this
 * exact path, while the envelope echoed `section` back as if it had been
 * honored. The extraction logic already existed and was exercised against
 * `query-commands.ts` directly, but never against the specifier production
 * actually resolves — so that coverage gave false confidence (mirrors the
 * mt#2783 `listTasksFromParams` incident; see `list-canonical-import-path.test.ts`
 * in this same directory for that precedent).
 *
 * Post-fix, `tasks.ts`'s `getTaskSpecContentFromParams` delegates to
 * `query-commands.ts`'s implementation, so this test doubles as a regression
 * guard against the two diverging again: if `tasks.ts` ever stops delegating
 * (or `query-commands.ts` stops forwarding/extracting `section`), this test —
 * which imports from the same specifier the production command uses — fails.
 */
import { describe, test, expect, mock } from "bun:test";
import { getTaskSpecContentFromParams } from "@minsky/domain/tasks";
import { ResourceNotFoundError } from "@minsky/domain/errors";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

const STUB_TASK = { id: "mt#test", title: "Test task", status: "TODO" } as unknown as Task;

const SPEC_CONTENT = [
  "## Summary",
  "",
  "This is the summary section.",
  "",
  "## Success Criteria",
  "",
  "- Criterion one",
  "- Criterion two",
  "",
  "## Scope",
  "",
  "In scope: everything.",
].join("\n");

/**
 * Mirrors the real backend's `getTaskSpecContent` contract (see
 * `packages/domain/src/tasks/minskyTaskBackend.ts` and `multi-backend-service.ts`):
 * it echoes `section` back on the result but does NOT do any extraction
 * itself — extraction is the caller's (query-commands.ts's) job. A stub that
 * did the extraction itself would defeat the point of this test.
 */
function makeStubTaskService(
  getTaskSpecContentMock: (
    taskId: string,
    section?: string
  ) => Promise<{ task: Task; specPath: string; content: string; section?: string }>
): TaskServiceInterface {
  return {
    listTasks: async () => [],
    getTask: async () => STUB_TASK,
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => ({ recordsAffected: 1 }),
    createTaskFromTitleAndSpec: async () => STUB_TASK,
    deleteTask: async () => false,
    getWorkspacePath: () => "/test/path",
    getTaskSpecContent: getTaskSpecContentMock,
  } as unknown as TaskServiceInterface;
}

describe("getTaskSpecContentFromParams via @minsky/domain/tasks (mt#3194 — the live CLI/MCP import path)", () => {
  test("a requested section returns ONLY that section's content, not the whole spec", async () => {
    const getTaskSpecContentMock = mock((taskId: string, section?: string) =>
      Promise.resolve({ task: STUB_TASK, specPath: "", content: SPEC_CONTENT, section })
    );
    const taskService = makeStubTaskService(getTaskSpecContentMock);

    const result = await getTaskSpecContentFromParams(
      { taskId: "mt#test", section: "Summary" },
      { taskService }
    );

    expect(result.content).toBe("## Summary\n\nThis is the summary section.");
    expect(result.content).not.toContain("Success Criteria");
    expect(result.content).not.toContain("Scope");
    expect(result.section).toBe("Summary");
    // Confirms `section` actually reaches the backend call — the exact
    // forwarding that was silently dropped pre-fix.
    expect(getTaskSpecContentMock).toHaveBeenCalledWith("mt#test", "Summary");
  });

  test("no section requested returns the full spec, unchanged", async () => {
    const getTaskSpecContentMock = mock((taskId: string, section?: string) =>
      Promise.resolve({ task: STUB_TASK, specPath: "", content: SPEC_CONTENT, section })
    );
    const taskService = makeStubTaskService(getTaskSpecContentMock);

    const result = await getTaskSpecContentFromParams({ taskId: "mt#test" }, { taskService });

    expect(result.content).toBe(SPEC_CONTENT);
    expect(result.section).toBeUndefined();
  });

  test("a section name that does not exist in the spec throws ResourceNotFoundError, never a silent fallback to the full document", async () => {
    const getTaskSpecContentMock = mock((taskId: string, section?: string) =>
      Promise.resolve({ task: STUB_TASK, specPath: "", content: SPEC_CONTENT, section })
    );
    const taskService = makeStubTaskService(getTaskSpecContentMock);

    await expect(
      getTaskSpecContentFromParams(
        { taskId: "mt#test", section: "Nonexistent Section" },
        { taskService }
      )
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test("a session param with no injected taskService does not hit the session-provider throw (workspace resolution falls back to cwd, matching every other command in this file)", async () => {
    // No taskService AND no persistenceProvider injected, with a `session`
    // param present — the shape that would reach
    // tasks/commands/shared-helpers.ts's session-aware resolveRepoPath
    // default, which throws "sessionProvider is required..." immediately,
    // before ever reaching the persistenceProvider check below it. This
    // facade overrides that default to preserve its pre-mt#3194
    // process.cwd()-based resolution (getTaskFromParams,
    // getTaskStatusFromParams, etc. all behave the same way — none of them
    // resolve `session` either). If the override works, resolution succeeds
    // and the call proceeds to (and fails on) the NEXT step instead — the
    // missing persistenceProvider — proving the session-provider throw was
    // avoided. Reviewer finding on PR #2303 (mt#3194).
    await expect(
      getTaskSpecContentFromParams({ taskId: "mt#test", session: "some-session" }, {})
    ).rejects.toThrow(/persistenceProvider is required/);
  });
});
