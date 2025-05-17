import { describe, expect, it, mock } from "bun:test";
import { resolveWorkspacePath, getSessionFromRepo } from "../workspace";
import type { WorkspaceResolutionOptions, TestDependencies } from "../workspace";
import { promises as fs } from "fs";
import { join } from "path";

describe("resolveWorkspacePath", () => {
  it("uses explicitly provided workspace path", async () => {
    const options: WorkspaceResolutionOptions = {
      workspace: "/test/workspace",
    };

    const mockAccess = mock(fs.access);
    mockAccess.mockImplementation(() => Promise.resolve());

    const mockDeps: TestDependencies = {
      access: mockAccess,
    };

    const result = await resolveWorkspacePath(options, mockDeps);

    expect(mockAccess).toHaveBeenCalledWith(join("/test/workspace", "process"));
    expect(result).toBe("/test/workspace");
  });

  it("returns current directory when no workspace option is provided", async () => {
    // Mock process.cwd()
    const originalCwd = process.cwd;
    process.cwd = () => "/current/directory";

    const result = await resolveWorkspacePath();

    expect(result).toBe("/current/directory");

    // Restore process.cwd
    process.cwd = originalCwd;
  });

  it("returns sessionRepo when provided", async () => {
    const options: WorkspaceResolutionOptions = {
      sessionRepo: "/session/repo/path",
    };

    const result = await resolveWorkspacePath(options);

    expect(result).toBe("/session/repo/path");
  });

  it("validates that explicitly provided workspace exists", async () => {
    const options: WorkspaceResolutionOptions = {
      workspace: "/invalid/workspace",
    };

    const mockAccess = mock(fs.access);
    mockAccess.mockImplementation(() => Promise.reject(new Error("ENOENT")));

    const mockDeps: TestDependencies = {
      access: mockAccess,
    };

    await expect(resolveWorkspacePath(options, mockDeps)).rejects.toThrow(
      "Invalid workspace path: /invalid/workspace"
    );
  });
});
