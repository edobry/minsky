import { describe, test, expect, mock, beforeEach, Mock } from "bun:test";
import { createGitCommitCommand } from "./commit";
import { GitService } from "../../domain/git";
import { SessionService } from "../../domain/session";
import { resolveRepoPath } from "../../utils/repo";

// Mock dependencies
mock.module("../../domain/git", () => ({
    GitService: mock.fn(() => ({
        getStatus: mock.fn(),
        stageAll: mock.fn(),
        stageModified: mock.fn(),
        commit: mock.fn()
    }))
}));

mock.module("../../domain/session", () => ({
    SessionService: mock.fn(() => ({
        getSession: mock.fn()
    }))
}));

mock.module("../../utils/repo", () => ({
    resolveRepoPath: mock.fn()
}));

describe("git commit command", () => {
    let command: ReturnType<typeof createGitCommitCommand>;
    let mockGitService: GitService;
    let mockSessionService: { getSession: Mock<any> };
    let mockConsoleLog: Mock<any>;
    let mockConsoleError: Mock<any>;
    let mockProcessExit: Mock<any>;

    beforeEach(() => {
        command = createGitCommitCommand();
        mockGitService = new GitService("") as any;
        mockSessionService = { getSession: mock.fn() };
        mockConsoleLog = mock.fn();
        mockConsoleError = mock.fn();
        mockProcessExit = mock.fn();

        // Capture console output
        console.log = mockConsoleLog;
        console.error = mockConsoleError;
        process.exit = mockProcessExit;

        // Reset mocks
        mock.restoreAll();
    });

    test("requires commit message unless amending", async () => {
        await command.parseAsync(["node", "minsky", "commit"]);
        expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Commit message is required"));
        expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    test("stages and commits changes with message", async () => {
        const mockStatus = { modified: ["file1"], untracked: [], deleted: [] };
        const mockCommitHash = "abc123";
        mockGitService.getStatus.mockResolvedValue(mockStatus);
        mockGitService.commit.mockResolvedValue(mockCommitHash);
        resolveRepoPath.mockResolvedValue("/path/to/repo");

        await command.parseAsync(["node", "minsky", "commit", "-m", "test commit"]);

        expect(mockGitService.stageModified).toHaveBeenCalled();
        expect(mockGitService.commit).toHaveBeenCalledWith("test commit", false);
        expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining(mockCommitHash));
    });

    test("adds task ID prefix when in session", async () => {
        const mockStatus = { modified: ["file1"], untracked: [], deleted: [] };
        const mockCommitHash = "abc123";
        const mockSession = { taskId: "123", repoPath: "/path/to/repo" };
        mockGitService.getStatus.mockResolvedValue(mockStatus);
        mockGitService.commit.mockResolvedValue(mockCommitHash);
        mockSessionService.getSession.mockResolvedValue(mockSession);

        await command.parseAsync(["node", "minsky", "commit", "-s", "test-session", "-m", "test commit"]);

        expect(mockGitService.commit).toHaveBeenCalledWith("task#123: test commit", false);
    });

    test("uses --all flag to stage all changes", async () => {
        const mockStatus = { modified: ["file1"], untracked: [], deleted: [] };
        mockGitService.getStatus.mockResolvedValue(mockStatus);
        resolveRepoPath.mockResolvedValue("/path/to/repo");

        await command.parseAsync(["node", "minsky", "commit", "-a", "-m", "test commit"]);

        expect(mockGitService.stageAll).toHaveBeenCalled();
        expect(mockGitService.stageModified).not.toHaveBeenCalled();
    });

    test("skips staging with --no-stage", async () => {
        const mockStatus = { modified: ["file1"], untracked: [], deleted: [] };
        mockGitService.getStatus.mockResolvedValue(mockStatus);
        resolveRepoPath.mockResolvedValue("/path/to/repo");

        await command.parseAsync(["node", "minsky", "commit", "--no-stage", "-m", "test commit"]);

        expect(mockGitService.stageAll).not.toHaveBeenCalled();
        expect(mockGitService.stageModified).not.toHaveBeenCalled();
    });

    test("amends previous commit", async () => {
        const mockStatus = { modified: ["file1"], untracked: [], deleted: [] };
        mockGitService.getStatus.mockResolvedValue(mockStatus);
        resolveRepoPath.mockResolvedValue("/path/to/repo");

        await command.parseAsync(["node", "minsky", "commit", "--amend", "-m", "amended commit"]);

        expect(mockGitService.commit).toHaveBeenCalledWith("amended commit", true);
    });

    test("errors when no changes to commit", async () => {
        const mockStatus = { modified: [], untracked: [], deleted: [] };
        mockGitService.getStatus.mockResolvedValue(mockStatus);
        resolveRepoPath.mockResolvedValue("/path/to/repo");

        await command.parseAsync(["node", "minsky", "commit", "-m", "test commit"]);

        expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("No changes to commit"));
        expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    test("errors when session not found", async () => {
        mockSessionService.getSession.mockResolvedValue(null);

        await command.parseAsync(["node", "minsky", "commit", "-s", "nonexistent", "-m", "test commit"]);

        expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Session 'nonexistent' not found"));
        expect(mockProcessExit).toHaveBeenCalledWith(1);
    });
}); 
