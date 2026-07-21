/**
 * Unit tests for the cursor-rules-ts compile target.
 *
 * Uses injected fake fs and dynamic-import stubs to avoid touching disk.
 */

import { describe, it, expect } from "bun:test";
import { makeCursorRulesTsTarget, buildRuleMdc } from "./cursor-rules-ts";
import type { MinskyCompileFsDeps } from "../types";
import type { RuleDefinition } from "../../definitions/types";
import { GENERATED_BANNER, GENERATION_BANNER_PATTERNS } from "../../rules/compile/banner-constants";
import { serializeRuleToMdc } from "../../rules/compile/targets/cursor-rules";
import type { Rule } from "../../rules/types";

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
    async chmod(_path: string, _mode: number): Promise<void> {
      // no-op in fake fs (permissions not tracked)
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

  it("includes tags: [] when array is empty (byte-parity: not normalized away, matches legacy)", () => {
    const mdc = buildRuleMdc({ ...sampleRule, tags: [] });
    expect(mdc).toContain("tags: []");
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

  // mt#1798: generated-file banner emitted as YAML comment inside frontmatter.
  describe("generated-file banner", () => {
    it("emits the banner as the second line of the file", () => {
      const mdc = buildRuleMdc(sampleRule);
      const lines = mdc.split("\n");
      expect(lines[0]).toBe("---");
      expect(lines[1]).toBe(GENERATED_BANNER);
    });

    it("banner matches at least one hook detection pattern (drift guard)", () => {
      // Imports the SAME `GENERATION_BANNER_PATTERNS` array the hook uses
      // (shared module per mt#1798). If either side drifts, this fails.
      const mdc = buildRuleMdc(sampleRule);
      const firstFiveLines = mdc.split("\n").slice(0, 5).join("\n");
      const matchedPattern = GENERATION_BANNER_PATTERNS.find((p) => p.re.test(firstFiveLines));
      expect(matchedPattern).toBeDefined();
      // We expect the hash-comment pattern specifically for cursor-rules-ts.
      expect(matchedPattern?.name).toBe("hash comment: Generated by");
    });

    it("banner present even when only the name field is set", () => {
      const minimal = {
        name: "minimal-rule",
        content: "Minimal content",
      } as unknown as RuleDefinition;
      const mdc = buildRuleMdc(minimal);
      expect(mdc.split("\n")[1]).toBe(GENERATED_BANNER);
    });

    it("banner survives complex YAML frontmatter (arrays, mixed types)", () => {
      const complex = {
        name: "complex-rule",
        description: `A description that contains : a colon and "quotes"`,
        globs: ["**/*.ts", "**/*.tsx", "src/**/*.{js,jsx}"],
        alwaysApply: true,
        tags: ["a-tag-with-dashes", "another_tag", "tag with spaces"],
        content: "Body content",
      } as unknown as RuleDefinition;
      const mdc = buildRuleMdc(complex);
      const lines = mdc.split("\n");
      expect(lines[0]).toBe("---");
      expect(lines[1]).toBe(GENERATED_BANNER);
      // Exactly two `---` delimiter lines; body content follows the closer.
      const delimiterLines = lines.filter((l) => l === "---");
      expect(delimiterLines.length).toBe(2);
      expect(mdc).toContain("Body content");
    });
  });
});

// ─── byte-parity with the legacy serializeRuleToMdc (mt#2995) ─────────────────
//
// The unified writer must reproduce the legacy `.cursor/rules/*.mdc` output
// byte-for-byte (Success Criterion "no content loss vs current"). Rather than
// re-deriving the legacy jsYaml options independently, these tests assert
// equality directly against `serializeRuleToMdc` (the legacy target's own
// serializer) for representative inputs spanning the fields that differ
// across rules in the corpus (name present/absent, globs, alwaysApply,
// tags, empty tags).

/** Build a legacy `Rule` from a RuleDefinition-shaped input for serializeRuleToMdc. */
function toLegacyRule(def: Partial<RuleDefinition> & { content: string }): Rule {
  return {
    id: def.name ?? "unnamed",
    name: def.name,
    description: def.description,
    globs: def.globs as string[] | undefined,
    alwaysApply: def.alwaysApply,
    tags: def.tags,
    content: def.content,
    format: "cursor",
    path: `/unused/${def.name ?? "unnamed"}.mdc`,
  };
}

describe("buildRuleMdc byte-parity with legacy serializeRuleToMdc", () => {
  it("matches legacy output for a full rule (name, description, globs, alwaysApply, tags)", () => {
    const def = sampleRule;
    expect(buildRuleMdc(def)).toBe(serializeRuleToMdc(toLegacyRule(def)));
  });

  it("matches legacy output when name is absent (21/54 corpus rules have no name:)", () => {
    const { name: _name, ...withoutName } = sampleRule;
    const def = withoutName as RuleDefinition;
    expect(buildRuleMdc(def)).toBe(serializeRuleToMdc(toLegacyRule(def)));
  });

  it("matches legacy output when alwaysApply is absent (no default line emitted)", () => {
    const { alwaysApply: _alwaysApply, ...withoutAlwaysApply } = sampleRule;
    const def = withoutAlwaysApply as RuleDefinition;
    expect(buildRuleMdc(def)).toBe(serializeRuleToMdc(toLegacyRule(def)));
  });

  it("matches legacy output when tags is an empty array (not normalized away)", () => {
    const def = { ...sampleRule, tags: [] };
    expect(buildRuleMdc(def)).toBe(serializeRuleToMdc(toLegacyRule(def)));
  });

  it("matches legacy output with complex globs/tags/alwaysApply combinations", () => {
    const def = {
      name: "complex-rule",
      description: `A description that contains : a colon and "quotes"`,
      globs: ["**/*.ts", "**/*.tsx", "src/**/*.{js,jsx}"],
      alwaysApply: true,
      tags: ["a-tag-with-dashes", "another_tag", "tag with spaces"],
      content: "Body content",
    } as RuleDefinition;
    expect(buildRuleMdc(def)).toBe(serializeRuleToMdc(toLegacyRule(def)));
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

  it("discovers both a TS-sourced rule and a flat-.mdc-sourced rule (mt#2995)", async () => {
    const target = makeCursorRulesTsTarget();
    // A subdir rule.ts and a flat .mdc for a DIFFERENT name both produce output.
    const fakeFs = makeFakeFs({
      [`${WORKSPACE}/.minsky/rules/my-rule/rule.ts`]: "// sentinel",
      [`${WORKSPACE}/.minsky/rules/flat-rule.mdc`]: "---\ndescription: flat\n---\ncontent\n",
    });

    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toHaveLength(2);
    expect(files.some((f) => /my-rule\.mdc$/.test(f))).toBe(true);
    expect(files.some((f) => /flat-rule\.mdc$/.test(f))).toBe(true);
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

  it("emits a flat-.mdc-sourced rule through compile() (mt#2995 — no longer skipped)", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeFakeFs({
        [`${WORKSPACE}/.minsky/rules/flat-rule.mdc`]:
          "---\ndescription: A flat rule.\nalwaysApply: true\n---\nFlat rule body content.\n",
      }),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };
    const target = makeCursorRulesTsTarget();

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsIncluded).toEqual(["flat-rule"]);
    expect(result.definitionsSkipped).toEqual([]);
    expect(result.filesWritten).toHaveLength(1);

    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    expect(outPath).toMatch(/\.cursor\/rules\/flat-rule\.mdc$/);
    expect(written[outPath]).toContain("Flat rule body content.");
    expect(written[outPath]).toContain("description: A flat rule.");
  });

  it("skips + warns an ambiguous 'both' source (flat .mdc + rule.ts for the same name)", async () => {
    // mt#2279-consistent policy: a name authored in BOTH formats is ambiguous;
    // skip it and surface a warning rather than silently preferring one format.
    const fakeFs = makeFakeFs({
      [`${WORKSPACE}/.minsky/rules/dup/rule.ts`]: "// sentinel",
      [`${WORKSPACE}/.minsky/rules/dup.mdc`]: "---\ndescription: dup\n---\ncontent\n",
    });
    const skips: string[] = [];
    const target = makeCursorRulesTsTarget(makeImportStub({}), (m) => skips.push(m));

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsSkipped).toContain("dup");
    expect(result.definitionsIncluded).toEqual([]);
    expect(skips.some((m) => m.includes("dup") && m.includes("ambiguous"))).toBe(true);
  });

  it("warns (does not silently swallow) when a rule.ts import fails (mt#2182)", async () => {
    const fakeFs = makeRuleFs("bad-rule");
    const importStub = async () => {
      throw new Error("module not found");
    };
    const skips: string[] = [];
    const target = makeCursorRulesTsTarget(importStub, (m) => skips.push(m));

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsSkipped).toEqual(["bad-rule"]);
    expect(skips.some((m) => m.includes("bad-rule") && m.includes("failed to import"))).toBe(true);
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
