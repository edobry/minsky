import { describe, expect, it, mock } from "bun:test";
import { resolveWorkspacePath } from "./workspace";
import type { WorkspaceResolutionOptions, TestDependencies } from "./workspace";
// Use mock.module() to mock filesystem operations
// import fs from "fs";
import { join } from "path";
describe("resolveWorkspacePath", () => {
  it("uses explicitly provided workspace path", async () => {
    const _options: WorkspaceResolutionOptions = {
      workspace: "/test/workspace",
    };

    let mockAccess = mock(fs.access);
    mockAccess = mock(() => Promise.resolve());

    const mockDeps: TestDependencies = {
      access: mockAccess,
    };

    const _result = await resolveWorkspacePath(_options, mockDeps);

    expect(mockAccess).toHaveBeenCalledWith("/test/workspace");
    expect(_result).toBe("/test/workspace");
  });

  it("returns current directory when no workspace option is provided", async () => {
    // Mock process.cwd()
    const originalCwd = process.cwd;
    process.cwd = () => "/current/directory";

    const _result = await resolveWorkspacePath();

    expect(_result).toBe("/current/directory");

    // Restore process.cwd
    process.cwd = originalCwd;
  });

  it("returns sessionRepo when provided", async () => {
    const _options: WorkspaceResolutionOptions = {
      sessionRepo: "/session/repo/path",
    };

    const _result = await resolveWorkspacePath(_options);

    expect(_result).toBe("/session/repo/path");
  });

  it("validates that explicitly provided workspace exists", async () => {
    const _options: WorkspaceResolutionOptions = {
      workspace: "/invalid/workspace",
    };

    let mockAccess = mock(fs.access);
    mockAccess = mock(() => Promise.reject(new Error("ENOENT")));

    const mockDeps: TestDependencies = {
      access: mockAccess,
    };

    await expect(resolveWorkspacePath(_options, mockDeps)).rejects.toThrow(
      "Invalid workspace path: /invalid/workspace"
    );
  });
});
