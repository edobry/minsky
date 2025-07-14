import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { resolveWorkspacePath } from "../workspace.js";
import { withDirectoryIsolation } from "../../utils/test-utils/cleanup-patterns.js";
import { createMock } from "../../utils/test-utils/mocking.js";

// Mock file system access
const mockAccess = createMock();

describe("resolveWorkspacePath", () => {
  const dirIsolation = withDirectoryIsolation();

  beforeEach(() => {
    dirIsolation.beforeEach();
    mockAccess.mockClear?.();
  });

  afterEach(() => {
    dirIsolation.afterEach();
  });

  it("returns current directory when no workspace option is provided", async () => {
    // Mock process.cwd() to return a specific directory
    dirIsolation.cwd.mockWorkingDirectory("/current/directory");

    const _result = await resolveWorkspacePath({}, { access: mockAccess });

    expect(_result).toBe("/current/directory");
  });

  it("uses explicitly provided workspace path", async () => {
    const _options = {
      workspace: "/test/workspace",
    };

    mockAccess.mockImplementation(() => Promise.resolve());

    const _result = await resolveWorkspacePath(_options, { access: mockAccess });

    expect(mockAccess).toHaveBeenCalledWith(join("/test/workspace", "process"));
    expect(_result).toBe("/test/workspace");
  });

  it("returns sessionRepo when provided", async () => {
    const _options = {
      sessionRepo: "/session/repo/path",
    };

    const _result = await resolveWorkspacePath(_options, { access: mockAccess });

    expect(_result).toBe("/session/repo/path");
  });

  it("validates that explicitly provided workspace exists", async () => {
    const _options = {
      workspace: "/invalid/workspace",
    };

    mockAccess.mockImplementation(() => Promise.reject(new Error("ENOENT")));

    await expect(resolveWorkspacePath(_options, { access: mockAccess })).rejects.toThrow(
      "Invalid workspace path: /invalid/workspace"
    );
  });
});
