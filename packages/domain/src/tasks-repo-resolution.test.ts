/**
 * Regression test for a PR #2326 review finding on mt#3190 (the
 * getTaskFromParams/getTaskStatusFromParams/updateTaskFromParams/
 * createTaskFromParams/createTaskFromTitleAndSpec/deleteTaskFromParams
 * consolidation).
 *
 * Every one of `tasks.ts`'s delegations to `tasks/commands/{query,mutation}-commands.ts`
 * needs a workspace-path override: none of this facade's callers can supply a
 * `sessionProvider` (that plumbing doesn't exist on `TaskServiceDeps`), so the
 * delegate's default `resolveRepoPath` (`tasks/commands/shared-helpers.ts`)
 * throws whenever a caller passes `session` without one. The original fix
 * (mt#3194, then mt#3190) used `async () => process.cwd()` — but that ignores
 * its arguments entirely, so a caller-supplied `repo` was ALSO silently
 * discarded on every one of these paths, not just create/delete as the
 * review's literal framing suggested (verified: every one of the six
 * mt#3190 delegations plus the pre-existing mt#3194 one used the identical
 * argument-ignoring closure).
 *
 * `resolveRepoOrCwd` is the fix: `repo` wins when given, `process.cwd()` is
 * the fallback only when neither `repo` nor a resolvable session is
 * available. It is exported from `tasks.ts` specifically so this — the exact
 * logic wired into all six delegations' `resolveRepoPath` (or, for
 * `getTaskFromParams`, a closure over `params` wrapping it in
 * `resolveMainWorkspacePath`, since that function's deps type doesn't expose
 * a `resolveRepoPath` field) — is directly testable without needing to mock
 * the real `createConfiguredTaskService` factory each delegate falls through
 * to when no `taskService` is injected.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { resolveRepoOrCwd } from "./tasks";

const CUSTOM_REPO_PATH = "/custom/repo/path";
const MOCK_CWD = "/mock/cwd/for-resolve-repo-or-cwd-test";

// Saved so the real process.cwd can be restored after every test. Bun's
// mock.restore() only rewinds spies created via spyOn/mock.module — it does
// NOT undo a raw property reassignment like `process.cwd = mock(...)`, so
// without this restore the mocked value leaks into every subsequent test
// file in the same bun test process (mt#2608 — same class of bug fixed in
// src/types/project.test.ts, errors/message-templates.test.ts, and
// tests/domain/commands/workspace.commands.test.ts).
const realCwd = process.cwd;

afterEach(() => {
  (process as unknown as Record<string, unknown>).cwd = realCwd;
});

describe("resolveRepoOrCwd (PR #2326 review fix — repo must survive facade delegation)", () => {
  test("a caller-supplied repo wins over process.cwd()", async () => {
    (process as unknown as Record<string, unknown>).cwd = mock(() => MOCK_CWD);

    const result = await resolveRepoOrCwd({ repo: CUSTOM_REPO_PATH });
    expect(result).toBe(CUSTOM_REPO_PATH);
  });

  test("repo still wins even when session is also supplied", async () => {
    (process as unknown as Record<string, unknown>).cwd = mock(() => MOCK_CWD);

    const result = await resolveRepoOrCwd({ repo: CUSTOM_REPO_PATH, session: "some-session" });
    expect(result).toBe(CUSTOM_REPO_PATH);
  });

  test("falls back to process.cwd() when repo is not given (session alone can't be resolved without a sessionProvider, which this facade never has)", async () => {
    (process as unknown as Record<string, unknown>).cwd = mock(() => MOCK_CWD);

    const result = await resolveRepoOrCwd({ session: "some-session" });
    expect(result).toBe(MOCK_CWD);
  });

  test("falls back to process.cwd() when neither repo nor session is given", async () => {
    (process as unknown as Record<string, unknown>).cwd = mock(() => MOCK_CWD);

    const result = await resolveRepoOrCwd({});
    expect(result).toBe(MOCK_CWD);
  });
});
