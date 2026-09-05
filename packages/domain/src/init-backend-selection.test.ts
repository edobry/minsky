/**
 * Tests for Init System Backend Selection
 *
 * Verifies that the init system properly respects user backend choices
 * and correctly handles the currently supported backends.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { initializeProject } from "./init";
import type { HarnessCompileAccounting, InitializeProjectDeps } from "./init";
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

  /**
   * Run `init` with BOTH environment-sensitive seams injected (mt#573).
   *
   * `resolveClient` and `compileForHarness` used to default to the real ones
   * here, which made these tests depend on the machine: `detectAgentHarness()`
   * reads `CLAUDECODE` from the ambient environment, so the same test resolved
   * to `claude-code` on a developer's machine inside Claude Code and to the
   * `cursor` fallback in CI — and mt#573 makes the two take different compile
   * paths. That is precisely the shape that shipped a CI failure past a green
   * local run in mt#5003 (a domain function reading past its injected
   * filesystem). Pinning both seams keeps these assertions about `init`'s
   * logic rather than about where they happen to run.
   */
  async function runInit(
    ruleFormat: "cursor" | "generic" | "minsky",
    client: "claude-code" | "cursor" = "claude-code",
    compiled: string[] = []
  ): Promise<void> {
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
      mockFileSystem,
      {
        resolveClient: () => client,
        compileForHarness: async (target) => {
          compiled.push(target);
          return { definitionsIncluded: [], definitionsSkipped: [] };
        },
      }
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

  // ─── mt#573 SC3: one SOURCE directory, every format ────────────────────────
  //
  // These two tests asserted the opposite until mt#573 ("still scaffolds into
  // .cursor/rules" / ".ai/rules"), and the change is deliberate rather than a
  // regression. `.cursor/rules` is a compile OUTPUT; writing sources there left
  // a Cursor project — and any project with no detected harness, since
  // `resolveInitClient` falls back to `cursor` — with nothing upstream for
  // selection to filter, so its rule set was fixed at `init` forever. What the
  // old assertions were really protecting is that the requested format is
  // HONOURED, and it still is: `.cursor/rules` is produced, as compiled output.

  test("ruleFormat 'cursor' scaffolds SOURCES into .minsky/rules (mt#573 SC3)", async () => {
    const compiled: string[] = [];
    await runInit("cursor", "cursor", compiled);

    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(true);
    expect(mockFileSystem.directories.has(dir(".ai", "rules"))).toBe(false);
    // `.cursor/rules` is now produced by the compile target, not by scaffolding,
    // so `init` itself creates no such directory — the target does.
    expect(compiled).toContain("cursor-rules-ts");
  });

  test("ruleFormat 'generic' scaffolds into .minsky/rules, not .ai/rules (mt#573 SC3)", async () => {
    await runInit("generic");

    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(true);
    // The one format that loses a directory. No compile target writes
    // `.ai/rules`, so `init` says so on stderr rather than leaving the operator
    // to notice — see the `generic` warning in `init.ts`.
    expect(mockFileSystem.directories.has(dir(".ai", "rules"))).toBe(false);
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
          // mt#4770: the seam now returns each target's per-rule accounting.
          // Empty here — this test asserts WHICH targets are compiled, not
          // rule reachability, and empty sets produce no reachability warning.
          return { definitionsIncluded: [], definitionsSkipped: [] };
        },
      }
    );

    // mt#5003: `claude-rules` ONLY. `init` no longer creates a CLAUDE.md, so on
    // a fresh project (this mock fs has none) the always-apply rules go to
    // `.claude/rules/` and `claude.md` is not compiled at all. Still exactly the
    // channels Claude Code implements (mt#3107) — the set is now one, not two.
    expect(compiled.map((c) => c.target)).toEqual(["claude-rules"]);
    expect(compiled.every((c) => c.workspacePath === testRepo)).toBe(true);
    // ...and the SOURCES they compile from are where the compile pipeline looks.
    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(true);
  });

  // Was "does NOT compile under a non-claude-code harness (mt#4715 SC3)".
  // mt#4715's finding was that a scaffolded project whose harness reads nothing
  // it was given is broken; its remedy compiled for Claude Code and left every
  // other harness alone, because under a Cursor `init` the sources were IN
  // `.cursor/rules` already and there was nothing to compile FROM. SC3 removed
  // that premise — sources are in `.minsky/rules` now — so the same finding
  // points the other way: a Cursor project must compile too, or it would be
  // scaffolded with files ITS harness never opens, which is mt#4715's own
  // defect with the harnesses swapped.
  test("a cursor harness compiles cursor-rules-ts from the shared sources (mt#573 SC3)", async () => {
    const compiled: string[] = [];
    await runInit("cursor", "cursor", compiled);

    expect(compiled).toEqual(["cursor-rules-ts"]);
    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(true);
  });

  // Was "claude-code + a non-minsky format does NOT compile (PR #3431 R1)".
  // R1's concern was concrete and is now resolved rather than overruled: it
  // objected that compiling would read an EMPTY `.minsky/rules`, leaving the
  // project with "neither the Cursor files it asked for nor usable Claude
  // ones". Sources land in `.minsky/rules` for every format now, so the
  // directory is populated and the project gets BOTH. The two harness branches
  // are independent by design — asking for Cursor output does not stop a Claude
  // Code project from receiving what its own harness reads.
  test("claude-code + --rule-format cursor compiles BOTH (mt#573 SC3)", async () => {
    const compiled: string[] = [];
    await runInit("cursor", "claude-code", compiled);

    expect(compiled.sort()).toEqual(["claude-rules", "cursor-rules-ts"]);
    expect(mockFileSystem.directories.has(dir(".minsky", "rules"))).toBe(true);
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

describe("Init reports rules unreachable by the harness (mt#4770)", () => {
  const testRepo = "/tmp/test-repo";
  let mockFileSystem: MockFs;

  beforeEach(() => {
    mockFileSystem = createMockFs();
  });

  const accounting = (
    definitionsIncluded: string[],
    definitionsSkipped: string[]
  ): HarnessCompileAccounting => ({
    definitionsIncluded,
    definitionsSkipped,
  });

  /**
   * Run init as Claude Code with `minsky` sources (the configuration that
   * compiles), capturing operator-facing warnings through the injected sink
   * rather than by spying on the logger module.
   */
  const runCapturingWarnings = async (
    compileForHarness: InitializeProjectDeps["compileForHarness"]
  ): Promise<string[]> => {
    const warnings: string[] = [];
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
        compileForHarness,
        warn: (message) => warnings.push(message),
      }
    );
    return warnings;
  };

  const reachabilityWarnings = (warnings: string[]): string[] =>
    warnings.filter((w) => w.includes("not reachable by Claude"));

  test("names every rule that lands in NEITHER target (AT2)", async () => {
    // The observed defect: all six stock templates are skipped by both
    // targets, so the project gets a stub CLAUDE.md and an empty
    // .claude/rules with nothing said about it.
    const warnings = await runCapturingWarnings(async () =>
      accounting([], ["index", "minsky-workflow"])
    );

    const reported = reachabilityWarnings(warnings);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("index");
    expect(reported[0]).toContain("minsky-workflow");
    // The message must name the ONLY retrieval path that actually works.
    expect(reported[0]).toContain("rules_get");
  });

  test("does NOT name a rule that reached either target (AT3)", async () => {
    // `index` is skipped by claude.md but INCLUDED by claude-rules — one
    // target is enough to be reachable, so only `minsky-workflow` qualifies.
    const warnings = await runCapturingWarnings(async (target) =>
      target === "claude.md"
        ? accounting([], ["index", "minsky-workflow"])
        : accounting(["index"], ["minsky-workflow"])
    );

    const reported = reachabilityWarnings(warnings);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("minsky-workflow");
    expect(reported[0]).not.toContain("index");
  });

  test("asserts no unreachability when a target throws (AT4)", async () => {
    const warnings = await runCapturingWarnings(async (target) => {
      if (target === "claude-rules") {
        throw new Error("compile unavailable");
      }
      return accounting([], ["minsky-workflow"]);
    });

    // The per-target failure is still surfaced...
    expect(warnings.some((w) => w.includes('could not compile "claude-rules"'))).toBe(true);
    // ...but a rule missing because a target CRASHED is not evidence that it is
    // ineligible, so the run must not claim it is unreachable.
    expect(reachabilityWarnings(warnings)).toEqual([]);
  });

  test("says nothing when every rule reaches a target (AT5)", async () => {
    // mt#5003: `claude-rules` is the only target `init` compiles on a fresh
    // project, and since it now carries the always-apply tier too, "every rule
    // reaches a target" means every rule reaches THIS one.
    const warnings = await runCapturingWarnings(async () =>
      accounting(["always-rule", "scoped-rule"], [])
    );

    expect(warnings).toEqual([]);
  });

  // ─── init tells the operator about a file it left alone (mt#4986 SC2/SC5) ──
  //
  // Pre-fix, measured live 2026-09-04 at `1c7a6366c`: `init` replaced a
  // hand-written 140-byte CLAUDE.md with 15,085 bytes, zero original lines
  // surviving, and emitted NOTHING. The compile layer now refuses the write;
  // this is the half that makes the refusal visible, because a silent skip
  // reproduces the defect in a quieter form.

  const FOREIGN_CLAUDE_MD_PATH = `${testRepo}/CLAUDE.md`;

  const skippedForeign = (
    definitionsIncluded: string[],
    definitionsSkipped: string[]
  ): HarnessCompileAccounting => ({
    definitionsIncluded,
    definitionsSkipped,
    skippedForeignOutputs: [
      {
        path: FOREIGN_CLAUDE_MD_PATH,
        reason: `${FOREIGN_CLAUDE_MD_PATH} was left untouched — it does not carry Minsky's generated-file banner`,
      },
    ],
  });

  const foreignWarnings = (warnings: string[]): string[] =>
    warnings.filter((w) => w.includes("left untouched"));

  test("reports a monolithic output left alone because it is the user's file", async () => {
    // Pins the REPORTING MECHANISM, not which target triggers it: whenever a
    // compiled target returns a `skippedForeignOutputs` entry, `init` surfaces
    // it. mt#5003 changed who can trigger it at init — `claude.md` is not
    // compiled unless a CLAUDE.md of ours already exists — so the stub is
    // attributed to the target `init` actually runs rather than to `claude.md`.
    const warnings = await runCapturingWarnings(async () => skippedForeign([], ["always-rule"]));

    const reported = foreignWarnings(warnings);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(FOREIGN_CLAUDE_MD_PATH);
    expect(reported[0]).toContain("banner");
  });

  test("reports the skip BEFORE the unreachability warning it explains", async () => {
    // Ordering is the whole point of emitting both. With CLAUDE.md left alone
    // every base rule is also unreachable, and the unreachability warning on
    // its own sends the operator hunting for a frontmatter problem that does
    // not exist.
    const warnings = await runCapturingWarnings(async () => skippedForeign([], ["always-rule"]));

    const foreignIndex = warnings.findIndex((w) => w.includes("left untouched"));
    const reachabilityIndex = warnings.findIndex((w) => w.includes("not reachable by Claude"));

    expect(foreignIndex).toBeGreaterThanOrEqual(0);
    expect(reachabilityIndex).toBeGreaterThanOrEqual(0);
    expect(foreignIndex).toBeLessThan(reachabilityIndex);
  });

  test("says nothing about foreign outputs when there are none", async () => {
    const warnings = await runCapturingWarnings(async (target) =>
      target === "claude.md"
        ? accounting(["always-rule"], ["scoped-rule"])
        : accounting(["scoped-rule"], ["always-rule"])
    );

    expect(foreignWarnings(warnings)).toEqual([]);
  });
});
