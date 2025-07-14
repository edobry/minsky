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

import { describe, test, expect, beforeEach } from "bun:test";
import { approveSessionFromParams } from "./session.js";
import type { SessionProviderInterface } from "./session.js";
import type { GitServiceInterface } from "./git.js";

describe("Session Approve Task Status Commit", () => {
  test("should commit task status update after successful merge", async () => {
    // Bug reproduction test - this should fail until the bug is fixed

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Mock successful git operations
        if (command.includes("git checkout main")) {
          return Promise.resolve("");
        }
        if (command.includes("git fetch origin")) {
          return Promise.resolve("");
        }
        if (command.includes("git show-ref --verify --quiet refs/heads/pr/task#123")) {
          return Promise.resolve(""); // PR branch exists
        }
        if (command.includes("git rev-parse pr/task#123")) {
          return Promise.resolve("abc123commit");
        }
        if (command.includes("git merge --ff-only pr/task#123")) {
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
        if (command.includes("git commit -m \"Update task #123 status to DONE\"")) {
          return Promise.resolve("");
        }
        if (command.includes("git push")) {
          return Promise.resolve("");
        }

        return Promise.resolve("");
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) => Promise.resolve({
        session: `task#${taskId}`,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId,
      }),
      getSession: (sessionName: string) => Promise.resolve({
        session: sessionName,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "123",
      }),
    };

    const mockTaskService = {
      getTaskStatus: (taskId: string) => {
        // Task is NOT already DONE, so status update should happen
        return Promise.resolve("IN-PROGRESS");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This simulates the task status update that modifies tasks.md
        return Promise.resolve();
      },
    };

    // Execute the session approval
    const result = await approveSessionFromParams(
      {
        task: "123",
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true);
    expect(result.taskId).toBe("#123"); // Task ID includes the # prefix

    // BUG: These assertions will fail until the bug is fixed
    // The task status update should be committed and pushed

    // Should check git status to see if there are uncommitted changes
    expect(gitCommands).toContain("git status --porcelain");

    // Should stage the tasks.md file
    expect(gitCommands).toContain("git add process/tasks.md");

    // Should commit the task status update
    expect(gitCommands).toContain("git commit -m \"Update task #123 status to DONE\"");

    // Should push the commit
    expect(gitCommands).toContain("git push");
  });

  test("should handle case where no task status update is needed", async () => {
    // Test edge case where task status doesn't change

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
        if (command.includes("git show-ref --verify --quiet refs/heads/pr/task#124")) {
          return Promise.resolve("");
        }
        if (command.includes("git rev-parse pr/task#124")) {
          return Promise.resolve("def456commit");
        }
        if (command.includes("git merge --ff-only pr/task#124")) {
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
      getSessionByTaskId: (taskId: string) => Promise.resolve({
        session: `task#${taskId}`,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId,
      }),
      getSession: (sessionName: string) => Promise.resolve({
        session: sessionName,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "124",
      }),
    };

    const mockTaskService = {
      getTaskStatus: (taskId: string) => {
        // Task is NOT already DONE, so status update should happen
        return Promise.resolve("TODO");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This simulates no actual file changes
        return Promise.resolve();
      },
    };

    // Execute the session approval
    const result = await approveSessionFromParams(
      {
        task: "124",
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
      }
    );

    // Verify the merge was successful
    expect(result.isNewlyApproved).toBe(true);

    // Should check git status
    expect(gitCommands).toContain("git status --porcelain");

    // Should NOT try to commit when there are no changes
    expect(gitCommands).not.toContain("git add process/tasks.md");
    expect(gitCommands).not.toContain("git commit -m \"Update task #124 status to DONE\"");
  });

  test("should skip task status update when task is already DONE", async () => {
    // Test case for the new behavior: check task status first and skip if already DONE

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Early exit commands should be handled first
        if (command.includes("git show-ref --verify --quiet refs/heads/pr/task#125")) {
          // PR branch doesn't exist - this should trigger early exit
          throw new Error("Command failed: git show-ref --verify --quiet refs/heads/pr/task#125");
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
        if (command.includes("git rev-parse pr/task#125")) {
          return Promise.resolve("ghi789commit");
        }
        if (command.includes("git merge --ff-only pr/task#125")) {
          return Promise.resolve("");
        }
        if (command.includes("git push origin main")) {
          return Promise.resolve("");
        }

        return Promise.resolve("");
      },
    };

    const mockSessionDB: Partial<SessionProviderInterface> = {
      getSessionByTaskId: (taskId: string) => Promise.resolve({
        session: `task${taskId}`,  // taskId is already "#125", so this becomes "task#125"
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId,
      }),
      getSession: (sessionName: string) => Promise.resolve({
        session: sessionName,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "125",
      }),
    };

    const mockTaskService = {
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
    const result = await approveSessionFromParams(
      {
        task: "125",
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
      }
    );

    // Should trigger early exit since task is DONE and PR branch doesn't exist
    expect(result.isNewlyApproved).toBe(false); // Session was already approved
    expect(result.taskId).toBe("#125");
    expect(result.session).toBe("task#125");

    // Should only call commands to check PR branch existence, then exit
    expect(gitCommands).toContain("git show-ref --verify --quiet refs/heads/pr/task#125");
    expect(gitCommands).toContain("git rev-parse HEAD");
    expect(gitCommands).toContain("git config user.name");

    // Should NOT attempt any merge operations
    expect(gitCommands).not.toContain("git checkout main");
    expect(gitCommands).not.toContain("git fetch origin");
    expect(gitCommands).not.toContain("git merge --ff-only pr/task#125");

    // Should NOT attempt any task status commit operations
    expect(gitCommands).not.toContain("git status --porcelain");
    expect(gitCommands).not.toContain("git add process/tasks.md");
    expect(gitCommands).not.toContain("git commit -m \"Update task #125 status to DONE\"");
    expect(gitCommands).not.toContain("git push");
  });

  test("should exit early when task is DONE and PR branch doesn't exist (bug reproduction)", async () => {
    // This test reproduces the exact bug scenario reported by the user:
    // - Task #266 is already DONE
    // - PR branch pr/task#266 doesn't exist (already merged and cleaned up)
    // - Command should exit early with success, not try to merge non-existent branch

    const gitCommands: string[] = [];
    const mockGitService: Partial<GitServiceInterface> = {
      execInRepository: (workdir: string, command: string) => {
        gitCommands.push(command);

        // Mock git operations
        if (command.includes("git show-ref --verify --quiet refs/heads/pr/task#266")) {
          // PR branch doesn't exist - this should trigger early exit
          throw new Error("Command failed: git show-ref --verify --quiet refs/heads/pr/task#266");
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
      getSessionByTaskId: (taskId: string) => Promise.resolve({
        session: `task${taskId}`,  // taskId is already "#266", so this becomes "task#266"
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId,
      }),
      getSession: (sessionName: string) => Promise.resolve({
        session: sessionName,
        repoName: "test-repo",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "266",
      }),
    };

    const mockTaskService = {
      getTaskStatus: (taskId: string) => {
        // Task is already DONE - this should trigger early exit check
        return Promise.resolve("DONE");
      },
      setTaskStatus: (taskId: string, status: string) => {
        // This should NOT be called due to early exit
        throw new Error("setTaskStatus should not be called when task is already DONE and PR branch doesn't exist");
      },
    };

    // Execute the session approval
    const result = await approveSessionFromParams(
      {
        task: "266",
        repo: "/test/repo",
      },
      {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
      }
    );

    // Verify early exit behavior
    expect(result.isNewlyApproved).toBe(false); // Session was already approved
    expect(result.taskId).toBe("#266");
    expect(result.session).toBe("task#266");

    // Should only call commands to check PR branch existence, then exit
    expect(gitCommands).toContain("git show-ref --verify --quiet refs/heads/pr/task#266");
    expect(gitCommands).toContain("git rev-parse HEAD");
    expect(gitCommands).toContain("git config user.name");

    // Should NOT attempt any merge operations
    expect(gitCommands).not.toContain("git checkout main");
    expect(gitCommands).not.toContain("git fetch origin");
    expect(gitCommands).not.toContain("git merge --ff-only pr/task#266");

    // Should NOT attempt any task status commit operations
    expect(gitCommands).not.toContain("git status --porcelain");
    expect(gitCommands).not.toContain("git add process/tasks.md");
    expect(gitCommands).not.toContain("git commit -m \"Update task #266 status to DONE\"");
  });
});
