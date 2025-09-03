/**
 * Tests for Init System Backend Selection
 *
 * Verifies that the init system properly respects user backend choices
 * instead of hardcoding markdown as the default.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { initializeProject } from "./init";
import * as path from "path";

describe("Init System Backend Selection", () => {
  let mockFileSystem: any;
  let capturedFiles: Map<string, string>;

  beforeEach(() => {
    capturedFiles = new Map();

    mockFileSystem = {
      existsSync: () => false,
      mkdirSync: () => {},
      writeFileSync: (filePath: string, content: string) => {
        capturedFiles.set(filePath, content);
      },
    };
  });

  test("should create configuration file with user's chosen backend", async () => {
    const testRepo = "/tmp/test-repo";

    // Test with each backend option
    const backends = ["markdown", "json-file", "github-issues", "minsky"] as const;

    for (const backend of backends) {
      capturedFiles.clear();

      await initializeProject(
        {
          repoPath: testRepo,
          backend: backend,
          ruleFormat: "cursor",
          mcp: { enabled: false }, // Disable MCP to avoid rule generation issues
          mcpOnly: false,
          overwrite: false,
          workflows: false, // Disable workflows to avoid initialization errors
        },
        mockFileSystem
      );

      // Verify config file was created with correct backend
      const configPath = path.join(testRepo, "config", "default.json");
      expect(capturedFiles.has(configPath)).toBe(true);

      const configContent = capturedFiles.get(configPath);
      expect(configContent).toBeDefined();

      const config = JSON.parse(configContent!);
      expect(config.tasks.backend).toBe(backend);
    }
  });

  test("should create appropriate files for each backend type", async () => {
    const testRepo = "/tmp/test-repo";

    // Test markdown backend
    capturedFiles.clear();
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "markdown",
        ruleFormat: "cursor",
        mcp: { enabled: false }, // Disable MCP to avoid rule generation issues
        mcpOnly: false,
        overwrite: false,
        workflows: false, // Disable workflows to avoid initialization errors
      },
      mockFileSystem
    );

    const markdownPath = path.join(testRepo, "process", "tasks.md");
    expect(capturedFiles.has(markdownPath)).toBe(true);
    expect(capturedFiles.get(markdownPath)).toContain("# Minsky Tasks");

    // Test json-file backend
    capturedFiles.clear();
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "json-file",
        ruleFormat: "cursor",
        mcp: { enabled: false }, // Disable MCP to avoid rule generation issues
        mcpOnly: false,
        overwrite: false,
        workflows: false, // Disable workflows to avoid initialization errors
      },
      mockFileSystem
    );

    const jsonPath = path.join(testRepo, "process", "tasks", "tasks.json");
    expect(capturedFiles.has(jsonPath)).toBe(true);
    const jsonContent = JSON.parse(capturedFiles.get(jsonPath)!);
    expect(jsonContent.tasks).toEqual([]);

    // Test github-issues backend (no files needed)
    capturedFiles.clear();
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "github-issues",
        ruleFormat: "cursor",
        mcp: { enabled: false }, // Disable MCP to avoid rule generation issues
        mcpOnly: false,
        overwrite: false,
        workflows: false, // Disable workflows to avoid initialization errors
      },
      mockFileSystem
    );

    // Should not create task files, only config
    const configPath = path.join(testRepo, "config", "default.json");
    expect(capturedFiles.has(configPath)).toBe(true);
    const config = JSON.parse(capturedFiles.get(configPath)!);
    expect(config.tasks.backend).toBe("github-issues");
  });

  test("should demonstrate the fix: no longer hardcoding markdown", async () => {
    const testRepo = "/tmp/test-repo";

    // When user chooses json-file, they should get json-file, not markdown
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "json-file",
        ruleFormat: "cursor",
        mcp: { enabled: false }, // Disable MCP to avoid rule generation issues
        mcpOnly: false,
        overwrite: false,
        workflows: false, // Disable workflows to avoid initialization errors
      },
      mockFileSystem
    );

    const configPath = path.join(testRepo, "config", "default.json");
    const configContent = capturedFiles.get(configPath);
    const config = JSON.parse(configContent!);

    // Verify user's choice is respected
    expect(config.tasks.backend).toBe("json-file");
    expect(config.tasks.backend).not.toBe("markdown");

    // Verify appropriate files are created
    const jsonPath = path.join(testRepo, "process", "tasks", "tasks.json");
    const markdownPath = path.join(testRepo, "process", "tasks.md");

    expect(capturedFiles.has(jsonPath)).toBe(true); // Should create JSON file
    expect(capturedFiles.has(markdownPath)).toBe(false); // Should NOT create markdown file
  });
});
