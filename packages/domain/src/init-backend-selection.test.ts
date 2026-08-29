/**
 * Tests for Init System Backend Selection
 *
 * Verifies that the init system properly respects user backend choices
 * and correctly handles the currently supported backends.
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

    // Test with each supported backend option
    const backends = ["github-issues", "minsky"] as const;

    for (const backend of backends) {
      mockFileSystem.files.clear();
      mockFileSystem.directories.clear();

      await initializeProject(
        {
          repoPath: testRepo,
          backend: backend,
          ruleFormat: "cursor",
          mcp: { enabled: false },
          overwrite: false,
        },
        mockFileSystem
      );

      // Verify config file was created at .minsky/config.yaml
      const configPath = path.join(testRepo, ".minsky", "config.yaml");
      expect(mockFileSystem.files.has(configPath)).toBe(true);

      const configContent = mockFileSystem.files.get(configPath);
      expect(configContent).toBeDefined();

      const config = yamlParse(configContent ?? "");
      expect(config.tasks.backend).toBe(backend);
      // When mcp.enabled is false, no mcp section should appear in config
      expect(config.mcp).toBeUndefined();
    }
  });

  test("routes the mcp section to the LOCAL overlay, not the committed config (mt#4699)", async () => {
    const testRepo = "/tmp/test-repo";

    await initializeProject(
      {
        repoPath: testRepo,
        backend: "minsky",
        ruleFormat: "cursor",
        mcp: { enabled: true, transport: "stdio" },
        overwrite: false,
      },
      mockFileSystem
    );

    const configPath = path.join(testRepo, ".minsky", "config.yaml");
    expect(mockFileSystem.files.has(configPath)).toBe(true);

    // Committed config no longer carries transport/port/host — they are machine
    // scope (mt#4699). This assertion is the inverse of what it was before.
    const config = yamlParse(mockFileSystem.files.get(configPath) ?? "");
    expect(config.mcp).toBeUndefined();

    // ...and they land in the gitignored overlay instead.
    const localPath = path.join(testRepo, ".minsky", "config.local.yaml");
    const local = yamlParse(mockFileSystem.files.get(localPath) ?? "");
    expect(local.mcp).toBeDefined();
    expect(local.mcp.transport).toBe("stdio");
  });

  test("should include mcp section with port and host for SSE transport", async () => {
    const testRepo = "/tmp/test-repo";

    await initializeProject(
      {
        repoPath: testRepo,
        backend: "minsky",
        ruleFormat: "cursor",
        mcp: { enabled: true, transport: "sse", port: 3000, host: "0.0.0.0" },
        overwrite: false,
      },
      mockFileSystem
    );

    const configPath = path.join(testRepo, ".minsky", "config.yaml");
    const config = yamlParse(mockFileSystem.files.get(configPath) ?? "");
    expect(config.mcp).toBeUndefined();

    // Port and host follow transport into the local overlay (mt#4699) — a port
    // is as machine-specific as a transport, so they move together.
    const localPath = path.join(testRepo, ".minsky", "config.local.yaml");
    const local = yamlParse(mockFileSystem.files.get(localPath) ?? "");
    expect(local.mcp.transport).toBe("sse");
    expect(local.mcp.port).toBe(3000);
    expect(local.mcp.host).toBe("0.0.0.0");
  });

  test("should create appropriate files for each backend type", async () => {
    const testRepo = "/tmp/test-repo";

    // Test minsky backend (no local task files needed - uses database)
    mockFileSystem.files.clear();
    mockFileSystem.directories.clear();
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "minsky",
        ruleFormat: "cursor",
        mcp: { enabled: false },
        overwrite: false,
      },
      mockFileSystem
    );

    const configPath = path.join(testRepo, ".minsky", "config.yaml");
    expect(mockFileSystem.files.has(configPath)).toBe(true);
    const minskyConfig = yamlParse(mockFileSystem.files.get(configPath) ?? "");
    expect(minskyConfig.tasks.backend).toBe("minsky");

    // Test github-issues backend (no files needed - uses GitHub API)
    mockFileSystem.files.clear();
    mockFileSystem.directories.clear();
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "github-issues",
        ruleFormat: "cursor",
        mcp: { enabled: false },
        overwrite: false,
      },
      mockFileSystem
    );

    // Should not create task files, only config
    const ghConfigPath = path.join(testRepo, ".minsky", "config.yaml");
    expect(mockFileSystem.files.has(ghConfigPath)).toBe(true);
    const ghConfig = yamlParse(mockFileSystem.files.get(ghConfigPath) ?? "");
    expect(ghConfig.tasks.backend).toBe("github-issues");
  });

  test("should reject unsupported legacy backends with a clear error", async () => {
    const testRepo = "/tmp/test-repo";

    // markdown and json-file backends are no longer supported
    const legacyBackends = ["markdown", "json-file"];

    for (const backend of legacyBackends) {
      await expect(
        initializeProject(
          {
            repoPath: testRepo,
            backend: backend as unknown as "minsky", // cast to satisfy TS; intentionally invalid
            ruleFormat: "cursor",
            mcp: { enabled: false },
            overwrite: false,
          },
          mockFileSystem
        )
      ).rejects.toThrow(`Backend "${backend}" is not supported.`);
    }
  });
});
