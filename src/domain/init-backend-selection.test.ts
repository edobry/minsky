/**
 * Tests for Init System Backend Selection
 *
 * Verifies that the init system properly respects user backend choices
 * instead of hardcoding markdown as the default.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { initializeProject } from "./init";
import * as path from "path";
import { parse as yamlParse } from "yaml";
import { createMockFs } from "./interfaces/mock-fs";
import type { MockFs } from "./interfaces/mock-fs";

describe("Init System Backend Selection", () => {
  let mockFileSystem: MockFs;

  beforeEach(() => {
    mockFileSystem = createMockFs();
  });

  test("should create configuration file with user's chosen backend", async () => {
    const testRepo = "/tmp/test-repo";

    // Test with each backend option
    const backends = ["markdown", "json-file", "github-issues", "minsky"] as const;

    for (const backend of backends) {
      mockFileSystem.files.clear();
      mockFileSystem.directories.clear();

      await initializeProject(
        {
          repoPath: testRepo,
          backend: backend,
          ruleFormat: "cursor",
          mcp: { enabled: false },
          mcpOnly: false,
          overwrite: false,
        },
        mockFileSystem
      );

      // Verify config file was created at .minsky/config.yaml
      const configPath = path.join(testRepo, ".minsky", "config.yaml");
      expect(mockFileSystem.files.has(configPath)).toBe(true);

      const configContent = mockFileSystem.files.get(configPath);
      expect(configContent).toBeDefined();

      const config = yamlParse(configContent!);
      expect(config.tasks.backend).toBe(backend);
    }
  });

  test("should create appropriate files for each backend type", async () => {
    const testRepo = "/tmp/test-repo";

    // Test markdown backend
    mockFileSystem.files.clear();
    mockFileSystem.directories.clear();
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "markdown",
        ruleFormat: "cursor",
        mcp: { enabled: false },
        mcpOnly: false,
        overwrite: false,
      },
      mockFileSystem
    );

    const markdownPath = path.join(testRepo, "process", "tasks.md");
    expect(mockFileSystem.files.has(markdownPath)).toBe(true);
    expect(mockFileSystem.files.get(markdownPath)).toContain("# Minsky Tasks");

    // Test json-file backend
    mockFileSystem.files.clear();
    mockFileSystem.directories.clear();
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "json-file",
        ruleFormat: "cursor",
        mcp: { enabled: false },
        mcpOnly: false,
        overwrite: false,
      },
      mockFileSystem
    );

    const jsonPath = path.join(testRepo, "process", "tasks", "tasks.json");
    expect(mockFileSystem.files.has(jsonPath)).toBe(true);
    const jsonContent = JSON.parse(mockFileSystem.files.get(jsonPath)!);
    expect(jsonContent.tasks).toEqual([]);

    // Test github-issues backend (no files needed)
    mockFileSystem.files.clear();
    mockFileSystem.directories.clear();
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "github-issues",
        ruleFormat: "cursor",
        mcp: { enabled: false },
        mcpOnly: false,
        overwrite: false,
      },
      mockFileSystem
    );

    // Should not create task files, only config
    const configPath = path.join(testRepo, ".minsky", "config.yaml");
    expect(mockFileSystem.files.has(configPath)).toBe(true);
    const config = yamlParse(mockFileSystem.files.get(configPath)!);
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
        mcp: { enabled: false },
        mcpOnly: false,
        overwrite: false,
      },
      mockFileSystem
    );

    const configPath = path.join(testRepo, ".minsky", "config.yaml");
    const configContent = mockFileSystem.files.get(configPath);
    const config = yamlParse(configContent!);

    // Verify user's choice is respected
    expect(config.tasks.backend).toBe("json-file");
    expect(config.tasks.backend).not.toBe("markdown");

    // Verify appropriate files are created
    const jsonPath = path.join(testRepo, "process", "tasks", "tasks.json");
    const markdownPath = path.join(testRepo, "process", "tasks.md");

    expect(mockFileSystem.files.has(jsonPath)).toBe(true); // Should create JSON file
    expect(mockFileSystem.files.has(markdownPath)).toBe(false); // Should NOT create markdown file
  });
});
