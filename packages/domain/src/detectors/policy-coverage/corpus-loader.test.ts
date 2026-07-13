/* eslint-disable custom/no-real-fs-in-tests -- corpus-loader is a directory-walker; testing it without real fs would require shimming readdir/readFile, defeating end-to-end coverage of the loader's filesystem handling */
/**
 * Tests for the policy corpus loader.
 *
 * Acceptance:
 *   - Loads CLAUDE.md project-level when present
 *   - Loads project rules from .claude/rules + .minsky/rules (.md/.mdc)
 *   - Loads memory files matching feedback_*.md / project_*.md
 *   - Gracefully handles missing directories (no throw, unavailableCount tracks)
 *   - Future .minsky/policy/* slot loads when present, otherwise no-op
 *
 * Reference: mt#1575 §Acceptance Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadClaudeMdFiles,
  loadProjectRules,
  loadMemoryFiles,
  loadPolicyFiles,
  loadPolicyCorpus,
  resolveMemoryDir,
} from "./corpus-loader";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "corpus-loader-test-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Filter out the user-level CLAUDE.md entry — it's loaded from ~/.claude/CLAUDE.md
 * regardless of the test's tempRoot, so tests asserting "empty workspace" must
 * exclude it. The user-level loading itself is correct production behavior;
 * we only filter in tests for hermeticity.
 */
function dropUserLevel<T extends { source: string }>(entries: T[]): T[] {
  return entries.filter((e) => e.source !== "CLAUDE.md (user)");
}

describe("loadClaudeMdFiles", () => {
  it("returns no project-level entries when no CLAUDE.md exists", async () => {
    const result = dropUserLevel(await loadClaudeMdFiles(tempRoot));
    expect(result).toEqual([]);
  });

  it("loads project-level CLAUDE.md", async () => {
    await writeFile(join(tempRoot, "CLAUDE.md"), "# project rules\nbe nice", "utf-8");
    const result = dropUserLevel(await loadClaudeMdFiles(tempRoot));
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("claude-md");
    expect(result[0]?.content).toContain("project rules");
  });

  it("loads .claude/CLAUDE.md when present in addition to top-level", async () => {
    await writeFile(join(tempRoot, "CLAUDE.md"), "top", "utf-8");
    await mkdir(join(tempRoot, ".claude"), { recursive: true });
    await writeFile(join(tempRoot, ".claude", "CLAUDE.md"), "nested", "utf-8");
    const result = dropUserLevel(await loadClaudeMdFiles(tempRoot));
    expect(result).toHaveLength(2);
    const sources = result.map((e) => e.source);
    expect(sources).toContain("CLAUDE.md (project)");
    expect(sources).toContain("CLAUDE.md (.claude/)");
  });
});

describe("loadProjectRules", () => {
  it("returns empty when neither rule dir exists", async () => {
    const result = await loadProjectRules(tempRoot);
    expect(result).toEqual([]);
  });

  it("loads .claude/rules/*.md and .minsky/rules/*.mdc", async () => {
    await mkdir(join(tempRoot, ".claude", "rules"), { recursive: true });
    await writeFile(join(tempRoot, ".claude", "rules", "alpha.md"), "alpha rule", "utf-8");
    await mkdir(join(tempRoot, ".minsky", "rules"), { recursive: true });
    await writeFile(
      join(tempRoot, ".minsky", "rules", "decision-defaults.mdc"),
      "## Datastores\nPostgres by default",
      "utf-8"
    );
    const result = await loadProjectRules(tempRoot);
    expect(result).toHaveLength(2);
    const sources = result.map((e) => e.source);
    expect(sources).toContain("alpha.md");
    expect(sources).toContain("decision-defaults.mdc");
  });

  it("ignores non-.md/.mdc/.txt files in rule dirs", async () => {
    await mkdir(join(tempRoot, ".claude", "rules"), { recursive: true });
    await writeFile(join(tempRoot, ".claude", "rules", "ignored.json"), "{}", "utf-8");
    const result = await loadProjectRules(tempRoot);
    expect(result).toEqual([]);
  });
});

describe("loadMemoryFiles", () => {
  it("returns empty when memory dir is absent", async () => {
    const result = await loadMemoryFiles(tempRoot);
    expect(result).toEqual([]);
  });

  it("returns empty when memory dir exists but has no matching files", async () => {
    const memoryDir = resolveMemoryDir(tempRoot);
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "random.md"), "not a feedback or project file", "utf-8");
    const result = await loadMemoryFiles(tempRoot);
    expect(result).toEqual([]);
    // Cleanup created memory dir to avoid pollution between tests
    await rm(memoryDir, { recursive: true, force: true });
  });

  it("loads feedback_* and project_* memory files", async () => {
    const memoryDir = resolveMemoryDir(tempRoot);
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "feedback_xyz.md"), "feedback content", "utf-8");
    await writeFile(join(memoryDir, "project_abc.md"), "project content", "utf-8");
    await writeFile(join(memoryDir, "user_profile.md"), "should be skipped", "utf-8");
    const result = await loadMemoryFiles(tempRoot);
    expect(result).toHaveLength(2);
    const names = result.map((e) => e.source).sort();
    expect(names).toEqual(["feedback_xyz.md", "project_abc.md"]);
    await rm(memoryDir, { recursive: true, force: true });
  });
});

describe("loadPolicyFiles", () => {
  it("returns empty when .minsky/policy is absent", async () => {
    const result = await loadPolicyFiles(tempRoot);
    expect(result).toEqual([]);
  });

  it("loads .minsky/policy/*.md when present", async () => {
    await mkdir(join(tempRoot, ".minsky", "policy"), { recursive: true });
    await writeFile(join(tempRoot, ".minsky", "policy", "team.md"), "policy text", "utf-8");
    const result = await loadPolicyFiles(tempRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("policy-file");
  });
});

describe("loadPolicyCorpus", () => {
  it("returns no project-level entries for a totally empty workspace", async () => {
    const corpus = await loadPolicyCorpus({ projectRoot: tempRoot });
    const projectEntries = dropUserLevel(corpus.entries);
    expect(projectEntries).toEqual([]);
    // The user-level CLAUDE.md (if any) is loaded as the only entry.
    // unavailableCount counts at least the missing project-rules dir; on hosts
    // without ~/.claude/CLAUDE.md it would also count the missing CLAUDE.md
    // group. We assert >= 1 to stay portable across hosts.
    expect(corpus.unavailableCount).toBeGreaterThanOrEqual(1);
  });

  it("loads CLAUDE.md + project rules + policy file together", async () => {
    await writeFile(join(tempRoot, "CLAUDE.md"), "top-level rules", "utf-8");
    await mkdir(join(tempRoot, ".claude", "rules"), { recursive: true });
    await writeFile(join(tempRoot, ".claude", "rules", "alpha.md"), "alpha", "utf-8");
    await mkdir(join(tempRoot, ".minsky", "policy"), { recursive: true });
    await writeFile(join(tempRoot, ".minsky", "policy", "team.md"), "team", "utf-8");
    const corpus = await loadPolicyCorpus({ projectRoot: tempRoot });
    const sources = corpus.entries.map((e) => e.source).sort();
    expect(sources).toContain("CLAUDE.md (project)");
    expect(sources).toContain("alpha.md");
    expect(sources).toContain("team.md");
    expect(corpus.loadedCount).toBeGreaterThanOrEqual(3);
  });

  it("does not throw on totally absent workspace dir (degenerate input)", async () => {
    const fake = join(tempRoot, "does-not-exist");
    const corpus = await loadPolicyCorpus({ projectRoot: fake });
    const projectEntries = dropUserLevel(corpus.entries);
    expect(projectEntries).toEqual([]);
  });
});

describe("resolveMemoryDir", () => {
  it("returns a path under ~/.claude/projects/<slug>/memory", () => {
    const memoryDir = resolveMemoryDir("/tmp/foo");
    expect(memoryDir).toContain(".claude/projects/-tmp-foo/memory");
  });
});
