/**
 * Unit tests for RuleService — YAML frontmatter parsing.
 *
 * Verifies that getRule() fails loudly (throws a descriptive error that identifies
 * the file path) when a rule file contains malformed YAML in its frontmatter,
 * rather than silently returning a rule with empty/stripped metadata.
 */

import { describe, it, expect } from "bun:test";
import { RuleService } from "./rule-service";

// ─── In-memory fs helpers ────────────────────────────────────────────────────
// A minimal fake fs that mimics the subset of node:fs/promises used by RuleService.
// Structural typing lets us avoid importing Dirent from "fs" (which the
// custom/no-real-fs-in-tests lint rule flags).

type FakeDirent = { name: string; isFile(): boolean; isDirectory(): boolean };
type FakeFs = {
  readdir(path: unknown, ...args: unknown[]): Promise<FakeDirent[]>;
  access(path: unknown, ...args: unknown[]): Promise<void>;
  readFile(path: unknown, ...args: unknown[]): Promise<Buffer>;
  mkdir(path: unknown, ...args: unknown[]): Promise<string | undefined>;
  writeFile(path: unknown, ...args: unknown[]): Promise<void>;
};

function makeFakeFs(files: Record<string, string>): FakeFs {
  return {
    async readdir(pathArg: unknown): Promise<FakeDirent[]> {
      const dir = String(pathArg);
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return Object.keys(files)
        .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
        .map((f) => ({
          name: f.slice(prefix.length),
          isFile: () => true,
          isDirectory: () => false,
        }));
    },
    async access(pathArg: unknown): Promise<void> {
      const p = String(pathArg);
      if (!(p in files)) {
        const err = Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: "ENOENT" });
        throw err;
      }
    },
    async readFile(pathArg: unknown): Promise<Buffer> {
      const p = String(pathArg);
      const content = files[p];
      if (content === undefined) {
        const err = Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: "ENOENT" });
        throw err;
      }
      return Buffer.from(content);
    },
    async mkdir(): Promise<undefined> {
      return undefined;
    },
    async writeFile(): Promise<void> {
      return undefined;
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("RuleService.getRule() — YAML frontmatter error handling", () => {
  it("throws a descriptive error when frontmatter contains an unquoted glob starting with *", async () => {
    // Reproduce the exact YAML that caused the data-loss bug:
    // an unquoted glob value starting with * is ambiguous in YAML 1.1 (parsed as an alias)
    const malformedMdc = `---
description: Guidelines for writing tests
globs: **/*.test.ts
alwaysApply: false
---
# Rule content here
`;
    const workspacePath = "/fake/workspace";
    const filePath = `${workspacePath}/.cursor/rules/bad-rule.mdc`;

    const service = new RuleService(workspacePath, {
      fsPromises: makeFakeFs({ [filePath]: malformedMdc }) as never,
    });

    await expect(service.getRule("bad-rule", { format: "cursor" })).rejects.toThrow(
      /Failed to parse YAML frontmatter in rule file.*bad-rule\.mdc/
    );
  });

  it("error message includes the file path so callers can identify the problem file", async () => {
    const malformedMdc = `---
globs: **/*.ts, **/*.tsx
---
# Content
`;
    const workspacePath = "/workspace";
    const filePath = `${workspacePath}/.cursor/rules/multi-glob-rule.mdc`;

    const service = new RuleService(workspacePath, {
      fsPromises: makeFakeFs({ [filePath]: malformedMdc }) as never,
    });

    let caughtError: Error | undefined;
    try {
      await service.getRule("multi-glob-rule", { format: "cursor" });
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeDefined();
    const message = caughtError?.message ?? "";
    expect(message).toContain("multi-glob-rule.mdc");
    expect(message).toContain("Failed to parse YAML frontmatter");
  });

  it("successfully parses a rule file with properly quoted globs", async () => {
    // Verify the fix: once globs are quoted, parsing succeeds and metadata is preserved
    const validMdc = `---
description: Guidelines for writing tests
globs:
  - "**/*.test.ts"
alwaysApply: false
tags: [testing]
---
# Rule content here
`;
    const workspacePath = "/workspace";
    const filePath = `${workspacePath}/.cursor/rules/good-rule.mdc`;

    const service = new RuleService(workspacePath, {
      fsPromises: makeFakeFs({ [filePath]: validMdc }) as never,
    });

    const rule = await service.getRule("good-rule", { format: "cursor" });

    expect(rule.id).toBe("good-rule");
    expect(rule.description).toBe("Guidelines for writing tests");
    expect(rule.globs).toEqual(["**/*.test.ts"]);
    expect(rule.alwaysApply).toBe(false);
    expect(rule.tags).toEqual(["testing"]);
  });
});

// ─── listRules deduplication tests ──────────────────────────────────────────

/**
 * Fake fs for listRules tests. readdir returns string[] (filenames) as the real
 * fs/promises.readdir does by default — unlike makeFakeFs above which returns
 * FakeDirent objects (needed by getRule tests for the .name property).
 */
function makeStringFs(files: Record<string, string>): FakeFs {
  return {
    async readdir(pathArg: unknown): Promise<FakeDirent[]> {
      const dir = String(pathArg);
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = Object.keys(files)
        .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
        .map((f) => f.slice(prefix.length));
      // Return as "strings" cast through the FakeDirent union — RuleService uses
      // for...of and calls .endsWith() on each element, which works for plain strings.
      return names as unknown as FakeDirent[];
    },
    async access(pathArg: unknown): Promise<void> {
      const p = String(pathArg);
      if (!(p in files)) {
        const err = Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: "ENOENT" });
        throw err;
      }
    },
    async readFile(pathArg: unknown): Promise<Buffer> {
      const p = String(pathArg);
      const content = files[p];
      if (content === undefined) {
        const err = Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: "ENOENT" });
        throw err;
      }
      return Buffer.from(content);
    },
    async mkdir(): Promise<undefined> {
      return undefined;
    },
    async writeFile(): Promise<void> {
      return undefined;
    },
  };
}

describe("RuleService.listRules() — cross-directory deduplication", () => {
  const minskyRuleMdc = `---
name: Shared Rule
description: Rule present in both minsky and cursor dirs
alwaysApply: true
---
# Shared Rule (minsky source)
Content from minsky source.
`;

  const cursorRuleMdc = `---
name: Shared Rule
description: Rule present in both minsky and cursor dirs
alwaysApply: true
---
# Shared Rule (cursor source)
Content from cursor source.
`;

  const cursorOnlyMdc = `---
name: Cursor Only Rule
description: Rule only in cursor dir
alwaysApply: true
---
# Cursor Only Rule
Cursor-only content.
`;

  it("deduplicates rules present in both .minsky/rules/ and .cursor/rules/", async () => {
    const workspacePath = "/workspace";
    const files: Record<string, string> = {
      [`${workspacePath}/.minsky/rules/shared-rule.mdc`]: minskyRuleMdc,
      [`${workspacePath}/.cursor/rules/shared-rule.mdc`]: cursorRuleMdc,
    };

    const service = new RuleService(workspacePath, {
      fsPromises: makeStringFs(files) as never,
    });

    const rules = await service.listRules({});
    const sharedRules = rules.filter((r) => r.id === "shared-rule");

    expect(sharedRules).toHaveLength(1);
  });

  it("prefers .minsky/rules/ version when the same ID exists in both dirs", async () => {
    const workspacePath = "/workspace";
    const files: Record<string, string> = {
      [`${workspacePath}/.minsky/rules/shared-rule.mdc`]: minskyRuleMdc,
      [`${workspacePath}/.cursor/rules/shared-rule.mdc`]: cursorRuleMdc,
    };

    const service = new RuleService(workspacePath, {
      fsPromises: makeStringFs(files) as never,
    });

    const rules = await service.listRules({});
    const rule = rules.find((r) => r.id === "shared-rule");

    expect(rule).toBeDefined();
    expect(rule?.format).toBe("minsky");
    expect(rule?.content).toContain("minsky source");
  });

  it("still includes rules that only appear in .cursor/rules/", async () => {
    const workspacePath = "/workspace";
    const files: Record<string, string> = {
      [`${workspacePath}/.minsky/rules/shared-rule.mdc`]: minskyRuleMdc,
      [`${workspacePath}/.cursor/rules/shared-rule.mdc`]: cursorRuleMdc,
      [`${workspacePath}/.cursor/rules/cursor-only.mdc`]: cursorOnlyMdc,
    };

    const service = new RuleService(workspacePath, {
      fsPromises: makeStringFs(files) as never,
    });

    const rules = await service.listRules({});

    expect(rules.some((r) => r.id === "cursor-only")).toBe(true);
    expect(rules.filter((r) => r.id === "shared-rule")).toHaveLength(1);
    expect(rules).toHaveLength(2);
  });

  it("does not deduplicate when a specific format is requested", async () => {
    // When format is specified, return all rules in that dir without dedup
    const workspacePath = "/workspace";
    const files: Record<string, string> = {
      [`${workspacePath}/.minsky/rules/shared-rule.mdc`]: minskyRuleMdc,
      [`${workspacePath}/.cursor/rules/shared-rule.mdc`]: cursorRuleMdc,
    };

    const service = new RuleService(workspacePath, {
      fsPromises: makeStringFs(files) as never,
    });

    const cursorRules = await service.listRules({ format: "cursor" });
    // With format specified, returns only cursor rules (no cross-dir dedup needed)
    expect(cursorRules).toHaveLength(1);
    expect(cursorRules[0]?.format).toBe("cursor");
    expect(cursorRules[0]?.content).toContain("cursor source");
  });
});
