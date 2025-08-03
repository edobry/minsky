/**
 * Test for bug: Session approve command updates task status but doesn't commit the change
 *
 * Bug description:
 * - When session approve runs, it merges the PR branch successfully
 * - It updates the task status to DONE in tasks.md
 * - But the tasks.md change is not committed, leaving the repository dirty
 *
 * Expected behavior:
 * - After session approval, the task status update should be committed
 * - The working directory should be clean (no uncommitted changes)
 * - The commit should be pushed to remote
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { approveSessionImpl } from "./session-approve-operations"; // EXPLICIT MOCK: Use the function that actually merges, not just approves
import type { SessionProviderInterface } from "../session";
import type { GitServiceInterface } from "../git";
import type { RepositoryBackend, MergeInfo } from "../repository/index";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
} from "../../utils/test-utils/index";

// EXPLICIT MOCK: Mock repository backend detection to prevent filesystem operations
mock.module("./repository-backend-detection", () => ({
  createRepositoryBackendForSession: mock(() =>
    Promise.resolve({
      getType: () => "local",
      mergePullRequest: () =>
        Promise.resolve({
          commitHash: "abc123def456",
          mergeDate: "2025-07-30T23:14:24.213Z",
          mergedBy: "Test User",
        }),
      approvePullRequest: () =>
        Promise.resolve({
          approvalId: "approval-123",
          approvedAt: "2025-07-30T23:14:24.213Z",
          approvedBy: "Test User",
        }),
    })
  ),
}));

describe("Session Approve Task Status Commit", () => {
  // Mock log functions used by session approve operations
  const log = {
    cli: mock(() => {}),
    info: mock(() => {}),
    debug: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
  };

  // Reusable mock for repository backend to prevent real shell execution
  const createMockRepositoryBackend = () =>
    mock((sessionRecord: any) =>
      Promise.resolve({
        getType: () => "local",
        mergePullRequest: mock(() =>
          Promise.resolve({
            commitHash: "abc123commit",
            mergeDate: new Date(),
            mergedBy: "test-user",
          })
        ),
        approvePullRequest: mock(() =>
          Promise.resolve({
            approvalId: "approval-default",
            approvedAt: new Date().toISOString(),
            approvedBy: "test-user",
          })
        ), // EXPLICIT MOCK: Add required approvePullRequest method
      })
    );

  beforeEach(() => {
    // Mock cleanup handled by bun:test automatically
  });

  test("should commit task status update after successful merge", async () => {
    // Bug reproduction test - this should fail until the bug is fixed

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "123";
    const QUALIFIED_TASK_ID = `md#${TASK_ID}`;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // TEMPLATE LITERAL: Correct session name format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // TEMPLATE LITERAL: Actual PR branch format
    const COMMIT_MESSAGE = `chore(${QUALIFIED_TASK_ID}): update task status to DONE`; // TEMPLATE LITERAL: System uses qualified task ID in commit messages

    const gitCommands: string[] = [];
    const mockGitService = createMockGitService({
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Mock successful git operations
        if (command.includes("git checkout main")) {
          return Promise.resolve("");
        }
        if (command.includes("git fetch origin")) {
          return Promise.resolve("");
        }
        if (command.includes(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`)) {
          return Promise.resolve(""); // PR branch exists
        }
        if (command.includes(`git rev-parse ${PR_BRANCH}`)) {
          return Promise.resolve("abc123commit");
        }
        if (command.includes(`git merge --ff-only ${PR_BRANCH}`)) {
          return Promise.resolve(""); // Merge succeeds
        }
        if (command.includes("git rev-parse HEAD")) {
          return Promise.resolve("abc123commit");
        }
        if (command.includes("git config user.name")) {
          return Promise.resolve("Test User");
        }
        if (command.includes("git push origin main")) {
          return Promise.resolve("");
        }
        if (command.includes("git status --porcelain")) {
          // After task status update, tasks.md should be modified
          return Promise.resolve("M process/tasks.md");
        }
        if (command.includes("git add process/tasks.md")) {
          return Promise.resolve("");
        }
        if (command.includes(`git commit -m "${COMMIT_MESSAGE}"`)) {
          // TEMPLATE LITERAL: Use extracted constant
          return Promise.resolve("");
        }
        if (command.includes("git push")) {
          return Promise.resolve("");
        }

        return Promise.resolve("");
      },
    });

    const mockSessionDB = createMockSessionProvider({
      getSessionByTaskId: (taskId: string) =>
        Promise.resolve({
          session: `task#${taskId}`, // TEMPLATE LITERAL: Clean session name construction
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId,
          prBranch: `pr/task#${taskId}`, // TEMPLATE LITERAL: Clean PR branch construction
        }),
      getSession: (sessionName: string) =>
        Promise.resolve({
          session: sessionName,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "123",
          prBranch: `pr/${sessionName}`, // EXPLICIT MOCK: Add required prBranch property
        }),
    });

    const mockTaskService = createMockTaskService({
      getTask: () =>
        Promise.resolve({
          id: "#123",
          title: "Test Task",
          status: "IN-PROGRESS",
        }),
      getTaskStatus: (taskId: string) => {
        // Task is NOT already DONE, so status update should happen
        return Promise.resolve("IN-PROGRESS");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This simulates the task status update that modifies tasks.md
        return Promise.resolve();
      },
    });

    // Mock repository backend to avoid filesystem validation
    const mockRepositoryBackend: RepositoryBackend = {
      getType: mock(() => "local"),
      mergePullRequest: mock(() =>
        Promise.resolve({
          commitHash: "abc123def456",
          mergeDate: "2025-07-30T23:14:24.213Z",
          mergedBy: "Test User",
        } as MergeInfo)
      ),
      approvePullRequest: mock(() =>
        Promise.resolve({
          approvalId: "approval-123",
          approvedAt: "2025-07-30T23:14:24.213Z",
          approvedBy: "Test User",
        })
      ), // EXPLICIT MOCK: Add required approvePullRequest method
    } as any;

    const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        createRepositoryBackend: mockCreateRepositoryBackend,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true); // EXPLICIT MOCK: Fixed to match approveSessionImpl return structure
    expect(result.taskId).toBe(QUALIFIED_TASK_ID); // TEMPLATE LITERAL: Use extracted constant

    // BUG: These assertions will fail until the bug is fixed
    // The task status update should be committed and pushed

    // Should check git status to see if there are uncommitted changes
    expect(gitCommands).toContain("git status --porcelain");

    // Should stage the tasks.md file
    expect(gitCommands).toContain("git add process/tasks.md");

    // Should commit the task status update
    expect(gitCommands).toContain(`git commit -m "${COMMIT_MESSAGE}"`); // TEMPLATE LITERAL: Use extracted constant

    // Should push the commit
    expect(gitCommands).toContain("git push");
  });

  test("should handle case where no task status update is needed", async () => {
    // Test edge case where task status doesn't change

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "124";
    const QUALIFIED_TASK_ID = `md#${TASK_ID}`;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // TEMPLATE LITERAL: Correct session name format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // TEMPLATE LITERAL: Actual PR branch format
    const COMMIT_MESSAGE = `chore(${QUALIFIED_TASK_ID}): update task status to DONE`;

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Mock git operations
        if (command.includes("git checkout main")) {
          return Promise.resolve("");
        }
        if (command.includes("git fetch origin")) {
          return Promise.resolve("");
        }
        if (command.includes(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`)) {
          // TEMPLATE LITERAL: Use extracted constant
          return Promise.resolve("");
        }
        if (command.includes(`git rev-parse ${PR_BRANCH}`)) {
          // TEMPLATE LITERAL: Use extracted constant
          return Promise.resolve("def456commit");
        }
        if (command.includes(`git merge --ff-only ${PR_BRANCH}`)) {
          // TEMPLATE LITERAL: Use extracted constant
          return Promise.resolve("");
        }
        if (command.includes("git rev-parse HEAD")) {
          return Promise.resolve("def456commit");
        }
        if (command.includes("git config user.name")) {
          return Promise.resolve("Test User");
        }
        if (command.includes("git push origin main")) {
          return Promise.resolve("");
        }
        if (command.includes("git status --porcelain")) {
          // No changes after task status update
          return Promise.resolve("");
        }

        return Promise.resolve("");
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) =>
        Promise.resolve({
          session: `task#${taskId}`,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId,
          prBranch: `pr/task#${taskId}`, // EXPLICIT MOCK: Add required prBranch property
        }),
      getSession: (sessionName: string) =>
        Promise.resolve({
          session: sessionName,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "124",
          prBranch: `pr/${sessionName}`, // EXPLICIT MOCK: Add required prBranch property
        }),
    };

    const mockTaskService = {
      getTask: () =>
        Promise.resolve({
          id: "#124",
          title: "Test Task",
          status: "TODO",
        }),
      getTaskStatus: (taskId: string) => {
        // Task is NOT already DONE, so status update should happen
        return Promise.resolve("TODO");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This simulates no actual file changes
        return Promise.resolve();
      },
    };

    // Mock repository backend to avoid filesystem validation
    const mockRepositoryBackend: RepositoryBackend = {
      getType: mock(() => "local"),
      mergePullRequest: mock(() =>
        Promise.resolve({
          commitHash: "def456abc789",
          mergeDate: "2025-07-30T23:14:24.213Z",
          mergedBy: "Test User",
        } as MergeInfo)
      ),
      approvePullRequest: mock(() =>
        Promise.resolve({
          approvalId: "approval-124",
          approvedAt: "2025-07-30T23:14:24.213Z",
          approvedBy: "Test User",
        })
      ), // EXPLICIT MOCK: Add required approvePullRequest method
    } as any;

    const mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        createRepositoryBackend: mockCreateRepositoryBackend,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true); // EXPLICIT MOCK: Fixed to match approveSessionImpl return structure

    // Should check git status
    expect(gitCommands).toContain("git status --porcelain");

    // Should NOT try to commit when there are no changes
    expect(gitCommands).not.toContain("git add process/tasks.md");
    expect(gitCommands).not.toContain(`git commit -m "${COMMIT_MESSAGE}"`); // TEMPLATE LITERAL: Use extracted constant
  });

  test("should skip task status update when task is already DONE", async () => {
    // Test case for the new behavior: check task status first and skip if already DONE

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "125";
    const QUALIFIED_TASK_ID = `md#${TASK_ID}`;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // TEMPLATE LITERAL: Correct session name format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // TEMPLATE LITERAL: Actual PR branch format

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Early exit commands should be handled first
        if (command.includes(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`)) {
          // TEMPLATE LITERAL: Use extracted constant
          // PR branch doesn't exist - this should trigger early exit
          throw new Error(`Command failed: git show-ref --verify --quiet refs/heads/${PR_BRANCH}`); // TEMPLATE LITERAL: Use extracted constant
        }
        if (command.includes("git rev-parse HEAD")) {
          return Promise.resolve("ghi789commit");
        }
        if (command.includes("git config user.name")) {
          return Promise.resolve("Test User");
        }

        // Normal merge flow commands (should not be reached due to early exit)
        if (command.includes("git checkout main")) {
          return Promise.resolve("");
        }
        if (command.includes("git fetch origin")) {
          return Promise.resolve("");
        }
        if (command.includes(`git rev-parse ${PR_BRANCH}`)) {
          // TEMPLATE LITERAL: Use extracted constant
          return Promise.resolve("ghi789commit");
        }
        if (command.includes(`git merge --ff-only ${PR_BRANCH}`)) {
          // TEMPLATE LITERAL: Use extracted constant
          return Promise.resolve("");
        }
        if (command.includes("git push origin main")) {
          return Promise.resolve("");
        }

        return Promise.resolve("");
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) =>
        Promise.resolve({
          session: `task${taskId}`, // taskId is already "#125", so this becomes "task#125"
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId,
          prBranch: `pr/task${taskId}`, // EXPLICIT MOCK: Add required prBranch property
        }),
      getSession: (sessionName: string) =>
        Promise.resolve({
          session: sessionName,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "125",
          prBranch: `pr/${sessionName}`, // EXPLICIT MOCK: Add required prBranch property
        }),
    };

    const mockTaskService = {
      getTask: () =>
        Promise.resolve({
          id: "#125",
          title: "Test Task",
          status: "DONE",
        }),
      getTaskStatus: (taskId: string) => {
        // Task is already DONE
        return Promise.resolve("DONE");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This should not be called since task is already DONE
        return Promise.resolve();
      },
    };

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        createRepositoryBackend: createMockRepositoryBackend(),
      }
    );

    // Should trigger early exit since task is DONE and PR branch doesn't exist
    expect(result.isNewlyApproved).toBe(false); // EXPLICIT MOCK: Correct - no PR branch means no new approval
    expect(result.taskId).toBe(QUALIFIED_TASK_ID); // TEMPLATE LITERAL: Use extracted constant
    expect(result.session).toBe(SESSION_NAME); // TEMPLATE LITERAL: Use extracted constant

    // Should only call commands to check PR branch existence, then exit
    expect(gitCommands).toContain(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`); // TEMPLATE LITERAL: Use extracted constant
    expect(gitCommands).toContain("git rev-parse HEAD");
    expect(gitCommands).toContain("git config user.name");

    // Should NOT attempt any merge operations
    expect(gitCommands).not.toContain("git checkout main");
    expect(gitCommands).not.toContain("git fetch origin");
    expect(gitCommands).not.toContain(`git merge --ff-only ${PR_BRANCH}`); // TEMPLATE LITERAL: Use extracted constant

    // Should NOT attempt any task status commit operations
    expect(gitCommands).not.toContain("git status --porcelain");
    expect(gitCommands).not.toContain("git add process/tasks.md");
    expect(gitCommands).not.toContain('git commit -m "chore(#125): update task status to DONE"');
    expect(gitCommands).not.toContain("git push");
  });

  test("should exit early when task is DONE and PR branch doesn't exist (bug reproduction)", async () => {
    // This test reproduces the exact bug scenario reported by the user:
    // - Task #266 is already DONE
    // - PR branch pr/task#266 doesn't exist (already merged and cleaned up)
    // - Command should exit early with success, not try to merge non-existent branch

    // TEMPLATE LITERAL: Extract constants to reduce string repetition
    const TASK_ID = "266";
    const QUALIFIED_TASK_ID = `md#${TASK_ID}`;
    const SESSION_NAME = `task-${QUALIFIED_TASK_ID}`; // TEMPLATE LITERAL: Correct session name format (with dash)
    const PR_BRANCH = `pr/${SESSION_NAME}`; // TEMPLATE LITERAL: Actual PR branch format

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Mock git operations
        if (command.includes(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`)) {
          // PR branch doesn't exist - this should trigger early exit
          throw new Error(`Command failed: git show-ref --verify --quiet refs/heads/${PR_BRANCH}`);
        }
        if (command.includes("git rev-parse HEAD")) {
          return Promise.resolve("c89cf17c");
        }
        if (command.includes("git config user.name")) {
          return Promise.resolve("Eugene Dobry");
        }

        return Promise.resolve("");
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) =>
        Promise.resolve({
          session: `task${taskId}`, // taskId is already "#266", so this becomes "task#266"
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId,
          prBranch: `pr/task${taskId}`, // EXPLICIT MOCK: Add required prBranch property
        }),
      getSession: (sessionName: string) =>
        Promise.resolve({
          session: sessionName,
          repoName: "test-repo",
          repoUrl: "/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "266",
          prBranch: `pr/${sessionName}`, // EXPLICIT MOCK: Add required prBranch property
        }),
    };

    const mockTaskService = {
      getTask: () =>
        Promise.resolve({
          id: "#266",
          title: "Test Task",
          status: "DONE",
        }),
      getTaskStatus: (taskId: string) => {
        // Task is already DONE - this should trigger early exit check
        return Promise.resolve("DONE");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This should NOT be called due to early exit
        throw new Error(
          "setTaskStatus should not be called when task is already DONE and PR branch doesn't exist"
        );
      },
    };

    // Execute the session approval
    const result = await approveSessionImpl(
      // EXPLICIT MOCK: Use function that merges
      {
        task: TASK_ID,
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        createRepositoryBackend: createMockRepositoryBackend(),
      }
    );

    // Verify early exit behavior
    expect(result.isNewlyApproved).toBe(false); // EXPLICIT MOCK: Correct - no PR branch means no new approval
    expect(result.taskId).toBe(QUALIFIED_TASK_ID); // TEMPLATE LITERAL: Use extracted constant
    expect(result.session).toBe(SESSION_NAME); // TEMPLATE LITERAL: Use extracted constant

    // Should only call commands to check PR branch existence, then exit
    expect(gitCommands).toContain(`git show-ref --verify --quiet refs/heads/${PR_BRANCH}`);
    expect(gitCommands).toContain("git rev-parse HEAD");
    expect(gitCommands).toContain("git config user.name");

    // Should NOT attempt any merge operations
    expect(gitCommands).not.toContain("git checkout main");
    expect(gitCommands).not.toContain("git fetch origin");
    expect(gitCommands).not.toContain("git merge --ff-only pr/task#266");

    // Should NOT attempt any task status commit operations
    expect(gitCommands).not.toContain("git status --porcelain");
    expect(gitCommands).not.toContain("git add process/tasks.md");
    expect(gitCommands).not.toContain('git commit -m "chore(#266): update task status to DONE"');
  });
});
