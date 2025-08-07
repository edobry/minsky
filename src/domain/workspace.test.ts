import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { resolveWorkspacePath } from "./workspace";
import type { WorkspaceResolutionOptions, TestDependencies } from "./workspace";
import { join } from "path";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";

describe("resolveWorkspacePath", () => {
  let mockFs: ReturnType<typeof createMockFilesystem>;

  beforeEach(() => {
    mockFs = createMockFilesystem();
    
    // Mock the fs module to use our mock filesystem
    mock.module("fs", () => ({
      default: {
        access: mockFs.access,
        existsSync: mockFs.existsSync,
        statSync: (path: string) => ({
          isDirectory: () => mockFs.directories.has(path),
        }),
      },
      access: mockFs.access,
      existsSync: mockFs.existsSync,
      statSync: (path: string) => ({
        isDirectory: () => mockFs.directories.has(path),
      }),
      promises: {
        access: mockFs.access,
      },
    }));
  });

  afterEach(() => {
    mockFs.cleanup();
    mock.restore();
  });
  it("uses explicitly provided workspace path", async () => {
    const _options: WorkspaceResolutionOptions = {
      workspace: "/test/workspace",
    };

    // Ensure the workspace exists in our mock filesystem
    mockFs.ensureDirectoryExists("/test/workspace");

    const mockDeps: TestDependencies = {
      access: mockFs.access,
    };

    const _result = await resolveWorkspacePath(_options, mockDeps);

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

    // Don't add the workspace to mockFs, so it doesn't exist
    // The mock filesystem will throw an error when trying to access a non-existent path

    const mockDeps: TestDependencies = {
      access: mockFs.access,
    };

    await expect(resolveWorkspacePath(_options, mockDeps)).rejects.toThrow(
      "Invalid workspace path: /invalid/workspace"
    );
  });
});
