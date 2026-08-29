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

// ─────────────────────────────────────────────────────────────────────────────
// mt#4714 — rule-format → output-directory mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("Init rule-format output directory (mt#4714)", () => {
  const testRepo = "/tmp/test-repo";
  let mockFileSystem: MockFs;

  beforeEach(() => {
    mockFileSystem = createMockFs();
  });

  async function runInit(ruleFormat: "cursor" | "generic" | "minsky"): Promise<void> {
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "minsky",
        ruleFormat,
        // MCP disabled so the run stays inside the filesystem — no client
        // registration, no daemon, no DB resolution.
        mcp: { enabled: false },
        overwrite: false,
      },
      mockFileSystem
    );
  }

  const dir = (...parts: string[]): string => path.join(testRepo, ...parts);

  test("ruleFormat 'minsky' scaffolds into .minsky/rules, not .ai/rules", async () => {
    await runInit("minsky");

    // The defect: init's two-way ternary sent every non-cursor format to
    // `.ai/rules`, so `minsky` landed in the `generic` location.
    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(true);
    expect(mockFileSystem.directories.has(dir(".ai", "rules"))).toBe(false);
    expect(mockFileSystem.directories.has(dir(".cursor", "rules"))).toBe(false);
  });

  test("ruleFormat 'cursor' still scaffolds into .cursor/rules", async () => {
    await runInit("cursor");

    expect(mockFileSystem.directories.has(dir(".cursor", "rules"))).toBe(true);
    expect(mockFileSystem.directories.has(dir(".ai", "rules"))).toBe(false);
    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(false);
  });

  test("ruleFormat 'generic' still scaffolds into .ai/rules", async () => {
    await runInit("generic");

    expect(mockFileSystem.directories.has(dir(".ai", "rules"))).toBe(true);
    expect(mockFileSystem.directories.has(dir(".cursor", "rules"))).toBe(false);
    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(false);
  });

  test("compiles for claude-code, and only the two channels it implements (mt#4715)", async () => {
    const compiled: Array<{ target: string; workspacePath: string }> = [];
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "minsky",
        ruleFormat: "minsky",
        mcp: { enabled: false },
        overwrite: false,
      },
      mockFileSystem,
      {
        resolveClient: () => "claude-code",
        compileForHarness: async (target, workspacePath) => {
          compiled.push({ target, workspacePath });
        },
      }
    );

    // Exactly the two channels Claude Code implements (mt#3107) — not the
    // full target set, which would write files nothing reads.
    expect(compiled.map((c) => c.target)).toEqual(["claude.md", "claude-rules"]);
    expect(compiled.every((c) => c.workspacePath === testRepo)).toBe(true);
    // ...and the SOURCES they compile from are where the compile pipeline looks.
    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(true);
  });

  test("does NOT compile under a non-claude-code harness (mt#4715 SC3)", async () => {
    const compiled: string[] = [];
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "minsky",
        ruleFormat: "cursor",
        mcp: { enabled: false },
        overwrite: false,
      },
      mockFileSystem,
      {
        resolveClient: () => "cursor",
        compileForHarness: async (target) => {
          compiled.push(target);
        },
      }
    );

    expect(compiled).toEqual([]);
    expect(mockFileSystem.directories.has(dir(".cursor", "rules"))).toBe(true);
  });

  test("claude-code + a non-minsky format does NOT compile (PR #3431 R1)", async () => {
    // The compile targets read `.minsky/rules`. An explicit `--rule-format
    // cursor` under Claude Code puts sources in `.cursor/rules`, so compiling
    // would read an empty directory — the project would get neither the Cursor
    // files it asked for nor usable Claude ones.
    const compiled: string[] = [];
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "minsky",
        ruleFormat: "cursor",
        mcp: { enabled: false },
        overwrite: false,
      },
      mockFileSystem,
      {
        resolveClient: () => "claude-code",
        compileForHarness: async (target) => {
          compiled.push(target);
        },
      }
    );

    expect(compiled).toEqual([]);
    // The explicitly-requested format is still honoured.
    expect(mockFileSystem.directories.has(dir(".cursor", "rules"))).toBe(true);
    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(false);
  });

  test("a failing compile does not fail init (mt#4715 SC5)", async () => {
    // The sources are still written and init still succeeds — a project with
    // sources but no compiled output is recoverable by running `minsky compile`.
    // The failure is surfaced through the logger rather than swallowed silently.
    await initializeProject(
      {
        repoPath: testRepo,
        backend: "minsky",
        ruleFormat: "minsky",
        mcp: { enabled: false },
        overwrite: false,
      },
      mockFileSystem,
      {
        resolveClient: () => "claude-code",
        compileForHarness: async () => {
          throw new Error("compile unavailable");
        },
      }
    );

    // init completed: the config file it writes AFTER the compile step exists.
    expect(mockFileSystem.files.has(path.join(testRepo, ".minsky", "config.yaml"))).toBe(true);
    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(true);
  });

  test("the .minsky config directory is created for every format", async () => {
    // Guards the discriminator the first test depends on: `.minsky` itself is
    // always created (config.yaml lives there), so "minsky format worked" can
    // only be read off `.minsky/rules` specifically — never off `.minsky`.
    for (const format of ["cursor", "generic", "minsky"] as const) {
      mockFileSystem.files.clear();
      mockFileSystem.directories.clear();
      await runInit(format);
      expect(mockFileSystem.directories.has(dir(".minsky"))).toBe(true);
    }
  });
});
