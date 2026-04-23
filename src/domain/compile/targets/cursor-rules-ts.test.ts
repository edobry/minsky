/**
 * Unit tests for the cursor-rules-ts compile target.
 *
 * Uses injected fake fs and dynamic-import stubs to avoid touching disk.
 */

import { describe, it, expect } from "bun:test";
import { makeCursorRulesTsTarget, buildRuleMdc } from "./cursor-rules-ts";
import type { MinskyCompileFsDeps } from "../types";
import type { RuleDefinition } from "../../definitions/types";

// ─── Fake fs ─────────────────────────────────────────────────────────────────

type FileMap = Record<string, string>;

function makeFakeFs(files: FileMap): MinskyCompileFsDeps {
  const written: FileMap = {};

  return {
    async readFile(path: string, _enc: "utf-8"): Promise<string> {
      const content = files[path] ?? written[path];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return content;
    },
    async writeFile(path: string, data: string, _enc: "utf-8"): Promise<void> {
      written[path] = data;
    },
    async mkdir(_path: string, _opts: { recursive: boolean }): Promise<undefined> {
      return undefined;
    },
    async readdir(path: string): Promise<string[]> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of [...Object.keys(files), ...Object.keys(written)]) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const segment = rest.split("/")[0];
          if (segment !== undefined) {
            names.add(segment);
          }
        }
      }
      return Array.from(names);
    },
    async access(path: string): Promise<void> {
      if (files[path] === undefined && written[path] === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WORKSPACE = "/workspace";

function ruleSourcePath(ruleName: string): string {
  return `${WORKSPACE}/.minsky/rules/${ruleName}/rule.ts`;
}

const sampleRule: RuleDefinition = {
  name: "my-rule",
  description: "A sample rule for testing.",
  alwaysApply: false,
  tags: ["testing"],
  content: "# My Rule\n\nDo something consistently.\n",
};

/** Make a fake fs that has a rule.ts sentinel (content doesn't matter — loaded via dynamicImport). */
function makeRuleFs(...ruleNames: string[]): MinskyCompileFsDeps {
  const files: FileMap = {};
  for (const name of ruleNames) {
    files[ruleSourcePath(name)] = "// sentinel";
  }
  return makeFakeFs(files);
}

/** Stub dynamic import: returns a module exporting the given rule as default. */
function makeImportStub(
  rulesByPath: Record<string, RuleDefinition>
): (path: string) => Promise<unknown> {
  return async (path: string) => {
    const rule = rulesByPath[path];
    if (rule === undefined) {
      throw new Error(`No stub for ${path}`);
    }
    return { default: rule };
  };
}

// ─── buildRuleMdc ─────────────────────────────────────────────────────────────

describe("buildRuleMdc", () => {
  it("includes description in frontmatter", () => {
    const mdc = buildRuleMdc(sampleRule);
    expect(mdc).toContain("description:");
    expect(mdc).toContain("A sample rule for testing.");
  });

  it("includes alwaysApply when set", () => {
    const mdc = buildRuleMdc({ ...sampleRule, alwaysApply: true });
    expect(mdc).toContain("alwaysApply: true");
  });

  it("includes alwaysApply: false when explicitly set to false", () => {
    const mdc = buildRuleMdc({ ...sampleRule, alwaysApply: false });
    expect(mdc).toContain("alwaysApply: false");
  });

  it("omits alwaysApply when not set", () => {
    const { alwaysApply: _alwaysApply, ...ruleWithout } = sampleRule;
    const mdc = buildRuleMdc(ruleWithout as RuleDefinition);
    expect(mdc).not.toContain("alwaysApply:");
  });

  it("includes tags in block style when provided", () => {
    const mdc = buildRuleMdc(sampleRule);
    expect(mdc).toContain("tags:");
    expect(mdc).toContain("testing");
  });

  it("omits tags when not provided", () => {
    const { tags: _tags, ...ruleWithout } = sampleRule;
    const mdc = buildRuleMdc(ruleWithout as RuleDefinition);
    expect(mdc).not.toContain("tags:");
  });

  it("omits tags when array is empty", () => {
    const mdc = buildRuleMdc({ ...sampleRule, tags: [] });
    expect(mdc).not.toContain("tags:");
  });

  it("includes globs as array when provided as string", () => {
    const mdc = buildRuleMdc({ ...sampleRule, globs: "**/*.ts" });
    expect(mdc).toContain("globs:");
    expect(mdc).toContain("**/*.ts");
  });

  it("includes globs as array when provided as array", () => {
    const mdc = buildRuleMdc({ ...sampleRule, globs: ["**/*.ts", "**/*.tsx"] });
    expect(mdc).toContain("globs:");
    expect(mdc).toContain("**/*.ts");
    expect(mdc).toContain("**/*.tsx");
  });

  it("omits globs when not provided", () => {
    const mdc = buildRuleMdc(sampleRule);
    expect(mdc).not.toContain("globs:");
  });

  it("includes name in frontmatter when provided", () => {
    const mdc = buildRuleMdc(sampleRule);
    expect(mdc).toContain("name: my-rule");
  });

  it("omits name when not provided", () => {
    const { name: _name, ...ruleWithout } = sampleRule;
    const mdc = buildRuleMdc(ruleWithout as RuleDefinition);
    expect(mdc).not.toContain("name:");
  });

  it("includes content body after frontmatter", () => {
    const mdc = buildRuleMdc(sampleRule);
    expect(mdc).toContain("# My Rule");
    expect(mdc).toContain("Do something consistently.");
  });

  it("has YAML frontmatter delimiters", () => {
    const mdc = buildRuleMdc(sampleRule);
    expect(mdc).toMatch(/^---\n/);
    expect(mdc).toContain("---\n");
  });
});

// ─── listOutputFiles ──────────────────────────────────────────────────────────

describe("cursorRulesTsTarget.listOutputFiles", () => {
  it("returns empty list when no rule subdirs exist", async () => {
    const target = makeCursorRulesTsTarget();
    const fakeFs = makeFakeFs({});
    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toEqual([]);
  });

  it("returns one .mdc path per rule directory", async () => {
    const target = makeCursorRulesTsTarget();
    const fakeFs = makeRuleFs("my-rule", "other-rule");

    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith(".mdc"))).toBe(true);
    expect(files.some((f) => f.includes("my-rule"))).toBe(true);
    expect(files.some((f) => f.includes("other-rule"))).toBe(true);
  });

  it("output paths are directly under .cursor/rules/ (flat, not nested)", async () => {
    const target = makeCursorRulesTsTarget();
    const fakeFs = makeRuleFs("my-rule");

    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toHaveLength(1);
    // Should be .cursor/rules/my-rule.mdc, NOT .cursor/rules/my-rule/something
    expect(files[0]).toMatch(/\.cursor\/rules\/my-rule\.mdc$/);
  });

  it("skips .mdc files in the rules source directory (legacy coexistence)", async () => {
    const target = makeCursorRulesTsTarget();
    // Simulate a legacy .mdc file alongside a subdir rule.ts
    const fakeFs = makeFakeFs({
      [`${WORKSPACE}/.minsky/rules/my-rule/rule.ts`]: "// sentinel",
      [`${WORKSPACE}/.minsky/rules/legacy.mdc`]: "---\ndescription: legacy\n---\ncontent\n",
    });

    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    // Only the subdir rule.ts is discovered; legacy.mdc is skipped
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/my-rule\.mdc$/);
  });
});

// ─── compile — normal mode ────────────────────────────────────────────────────

describe("cursorRulesTsTarget.compile (normal)", () => {
  it("writes rule .mdc for each discovered rule", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeRuleFs("my-rule"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({ [ruleSourcePath("my-rule")]: sampleRule });
    const target = makeCursorRulesTsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsIncluded).toEqual(["my-rule"]);
    expect(result.definitionsSkipped).toEqual([]);
    expect(result.filesWritten).toHaveLength(1);
    expect(result.content).toBeUndefined();

    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    expect(outPath).toContain("my-rule");
    expect(outPath).toEndWith(".mdc");
    expect(written[outPath]).toContain("description:");
  });

  it("skips a rule whose import throws", async () => {
    const fakeFs = makeRuleFs("bad-rule");
    const importStub = async () => {
      throw new Error("module not found");
    };
    const target = makeCursorRulesTsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["bad-rule"]);
    expect(result.definitionsIncluded).toEqual([]);
  });

  it("skips a rule that fails schema validation", async () => {
    const fakeFs = makeRuleFs("invalid-rule");
    // Return a module with an invalid default (missing required fields)
    const importStub = async (_path: string) => ({ default: { description: "" } });
    const target = makeCursorRulesTsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["invalid-rule"]);
  });

  it("skips a rule when dirName !== rule.name (invariant enforcement)", async () => {
    // Compile enforces dirName === rule.name so that listOutputFiles
    // (which only sees dirNames) and the compile output paths agree. When they
    // differ, the rule is skipped. This preserves the invariant that the output
    // filename stem matches the frontmatter `name`.
    const fakeFs = makeRuleFs("dir-name-x");
    const ruleWithDifferentName: RuleDefinition = { ...sampleRule, name: "rule-name-y" };
    const importStub = makeImportStub({
      [ruleSourcePath("dir-name-x")]: ruleWithDifferentName,
    });
    const target = makeCursorRulesTsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsSkipped).toEqual(["dir-name-x"]);
    expect(result.definitionsIncluded).toEqual([]);
    expect(result.filesWritten).toEqual([]);
  });

  it("skips a rule when rule.name is undefined (invariant enforcement)", async () => {
    // rule.name is optional in RuleDefinition but required for the TS target
    // to enforce the dirName === rule.name invariant. Without a name, we can't
    // produce a stable output path.
    const fakeFs = makeRuleFs("unnamed-rule");
    const { name: _name, ...ruleWithoutName } = sampleRule;
    const importStub = makeImportStub({
      [ruleSourcePath("unnamed-rule")]: ruleWithoutName as RuleDefinition,
    });
    const target = makeCursorRulesTsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsSkipped).toEqual(["unnamed-rule"]);
    expect(result.definitionsIncluded).toEqual([]);
  });

  it("produces output at .cursor/rules/<name>.mdc when dirName === rule.name", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeRuleFs("my-rule"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({
      [ruleSourcePath("my-rule")]: { ...sampleRule, name: "my-rule" },
    });
    const target = makeCursorRulesTsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.filesWritten).toHaveLength(1);
    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    expect(outPath).toMatch(/\.cursor\/rules\/my-rule\.mdc$/);
  });

  it("compiles multiple rules and writes them individually", async () => {
    const written: Record<string, string> = {};
    const ruleA: RuleDefinition = { ...sampleRule, name: "rule-a" };
    const ruleB: RuleDefinition = { ...sampleRule, name: "rule-b" };
    const fakeFs: MinskyCompileFsDeps = {
      ...makeRuleFs("rule-a", "rule-b"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({
      [ruleSourcePath("rule-a")]: ruleA,
      [ruleSourcePath("rule-b")]: ruleB,
    });
    const target = makeCursorRulesTsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsIncluded).toHaveLength(2);
    expect(result.filesWritten).toHaveLength(2);
    expect(result.definitionsSkipped).toEqual([]);
  });
});

// ─── compile — dryRun mode ────────────────────────────────────────────────────

describe("cursorRulesTsTarget.compile (dryRun)", () => {
  it("does not write files and populates content and contentsByPath", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeRuleFs("my-rule"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({ [ruleSourcePath("my-rule")]: sampleRule });
    const target = makeCursorRulesTsTarget(importStub);

    const result = await target.compile({ dryRun: true }, WORKSPACE, fakeFs);

    expect(Object.keys(written)).toHaveLength(0);
    expect(result.content).toBeDefined();
    expect(result.contentsByPath).toBeDefined();

    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    if (result.contentsByPath === undefined)
      throw new Error("expected contentsByPath to be defined");
    expect(result.contentsByPath.get(outPath)).toContain("description:");
  });
});
