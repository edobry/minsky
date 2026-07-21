/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: the corpus-fidelity test reads the repo's real .minsky/rules/*.mdc set to prove the reader parses the actual rule corpus; mocking fs would defeat that specific assertion. The remaining tests use an injected in-memory fs. */
/**
 * Tests for the flat-`.mdc` + `rule.ts` rule source reader (mt#2994, Phase 2;
 * updated mt#2995, Phase 3, for the `extractRuleDefinitionFromMdc` byte-parity
 * signature change).
 *
 * Covers: source discovery (ts / mdc / both / empty), markdown parse+validate
 * (valid / malformed / schema-invalid / name-omitted / tag-normalize), and a
 * corpus-fidelity pass over the repo's real flat `.minsky/rules/*.mdc` rules
 * proving they round-trip into valid `RuleDefinition`s with no content loss.
 */

import { describe, it, expect } from "bun:test";
import { join } from "path";
import realFs from "fs/promises";
import {
  discoverRuleSources,
  extractRuleDefinitionFromMdc,
  ruleSourceDir,
  ruleTsPath,
  ruleMdcPath,
} from "./rule-sources";
import type { MinskyCompileFsDeps } from "./types";

/**
 * Minimal in-memory fs satisfying the subset `discoverRuleSources` uses
 * (`readdir` + `access`). `dirs` maps a directory path → its entries; `files`
 * is the set of paths that exist (so `access` resolves).
 */
function fakeFs(dirs: Record<string, string[]>, files: string[]): MinskyCompileFsDeps {
  const fileSet = new Set(files);
  return {
    async readdir(path: string): Promise<string[]> {
      const entries = dirs[path];
      if (!entries) throw new Error(`ENOENT: ${path}`);
      return entries;
    },
    async access(path: string): Promise<void> {
      if (!fileSet.has(path)) throw new Error(`ENOENT: ${path}`);
    },
    async readFile(_path: string, _enc: "utf-8"): Promise<string> {
      throw new Error("readFile not used in discovery");
    },
    async writeFile(_path: string, _data: string, _enc: "utf-8"): Promise<void> {
      throw new Error("writeFile not used");
    },
    async mkdir(_path: string, _opts: { recursive: boolean }): Promise<string | undefined> {
      return undefined;
    },
    async chmod(_path: string, _mode: number): Promise<void> {},
  };
}

const WS = "/ws";
const RULES = ruleSourceDir(WS); // /ws/.minsky/rules

describe("discoverRuleSources", () => {
  it("discovers a flat <name>.mdc as an mdc source", async () => {
    const fs = fakeFs({ [RULES]: ["foo.mdc"] }, []);
    const sources = await discoverRuleSources(WS, fs);
    expect(sources).toEqual([{ kind: "mdc", name: "foo", path: ruleMdcPath(WS, "foo") }]);
  });

  it("discovers a <name>/rule.ts as a ts source", async () => {
    const fs = fakeFs({ [RULES]: ["bar"] }, [ruleTsPath(WS, "bar")]);
    const sources = await discoverRuleSources(WS, fs);
    expect(sources).toEqual([{ kind: "ts", name: "bar", path: ruleTsPath(WS, "bar") }]);
  });

  it("marks a name with BOTH a flat .mdc and a rule.ts as ambiguous (kind: both)", async () => {
    const fs = fakeFs({ [RULES]: ["baz.mdc", "baz"] }, [ruleTsPath(WS, "baz")]);
    const sources = await discoverRuleSources(WS, fs);
    expect(sources).toEqual([
      {
        kind: "both",
        name: "baz",
        tsPath: ruleTsPath(WS, "baz"),
        mdcPath: ruleMdcPath(WS, "baz"),
      },
    ]);
  });

  it("ignores directories without a rule.ts", async () => {
    // "notarule" is a dir with no rule.ts → not a source.
    const fs = fakeFs({ [RULES]: ["foo.mdc", "notarule"] }, []);
    const sources = await discoverRuleSources(WS, fs);
    expect(sources).toEqual([{ kind: "mdc", name: "foo", path: ruleMdcPath(WS, "foo") }]);
  });

  it("returns a mixed set sorted by name", async () => {
    const fs = fakeFs({ [RULES]: ["zeta.mdc", "alpha", "mid.mdc"] }, [ruleTsPath(WS, "alpha")]);
    const sources = await discoverRuleSources(WS, fs);
    expect(sources.map((s) => `${s.name}:${s.kind}`)).toEqual(["alpha:ts", "mid:mdc", "zeta:mdc"]);
  });

  it("returns [] when the rules directory is missing/unreadable", async () => {
    const fs = fakeFs({}, []); // readdir of RULES throws
    const sources = await discoverRuleSources(WS, fs);
    expect(sources).toEqual([]);
  });
});

describe("extractRuleDefinitionFromMdc", () => {
  const validRaw = [
    "---",
    "description: A test rule",
    "alwaysApply: false",
    "globs:",
    "  - '**/*.ts'",
    "tags:",
    "  - testing",
    "---",
    "",
    "# Body content here",
  ].join("\n");

  it("parses frontmatter + body into a validated RuleDefinition", () => {
    const result = extractRuleDefinitionFromMdc(validRaw, "/ws/.minsky/rules/x.mdc");
    expect("rule" in result).toBe(true);
    if (!("rule" in result)) return;
    expect(result.rule.description).toBe("A test rule");
    expect(result.rule.alwaysApply).toBe(false);
    expect(result.rule.globs).toEqual(["**/*.ts"]);
    expect(result.rule.tags).toEqual(["testing"]);
    expect(result.rule.content).toContain("# Body content here");
  });

  it("leaves name undefined when frontmatter omits `name` (byte-parity — no filename default)", () => {
    const result = extractRuleDefinitionFromMdc(validRaw, "/p/my-rule.mdc");
    expect("rule" in result).toBe(true);
    if (!("rule" in result)) return;
    expect(result.rule.name).toBeUndefined();
  });

  it("strips the schema-defaulted alwaysApply when the source omits it (byte-parity)", () => {
    const raw = ["---", "description: d", "---", "", "body"].join("\n");
    const result = extractRuleDefinitionFromMdc(raw, "/p/no-always-apply.mdc");
    expect("rule" in result).toBe(true);
    if (!("rule" in result)) return;
    expect(result.rule.alwaysApply).toBeUndefined();
    expect("alwaysApply" in result.rule).toBe(false);
  });

  it("trims the content body (matches legacy RuleService's content.trim())", () => {
    const raw = ["---", "description: d", "---", "", "  body with padding  ", ""].join("\n");
    const result = extractRuleDefinitionFromMdc(raw, "/p/f.mdc");
    expect("rule" in result).toBe(true);
    if (!("rule" in result)) return;
    expect(result.rule.content).toBe("body with padding");
  });

  it("prefers the frontmatter `name` over leaving it undefined", () => {
    const raw = ["---", "name: explicit-name", "description: d", "---", "", "body"].join("\n");
    const result = extractRuleDefinitionFromMdc(raw, "/p/file.mdc");
    expect("rule" in result).toBe(true);
    if (!("rule" in result)) return;
    expect(result.rule.name).toBe("explicit-name");
  });

  it("normalizes a single-string `tags` value to an array", () => {
    const raw = ["---", "description: d", "tags: solo", "---", "", "body"].join("\n");
    const result = extractRuleDefinitionFromMdc(raw, "/p/f.mdc");
    expect("rule" in result).toBe(true);
    if (!("rule" in result)) return;
    expect(result.rule.tags).toEqual(["solo"]);
  });

  it("returns an error (does not throw) for a schema-invalid rule with no description", () => {
    const raw = ["---", "alwaysApply: false", "tags:", "  - x", "---", "", "body"].join("\n");
    const result = extractRuleDefinitionFromMdc(raw, "/p/nodesc.mdc");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("Invalid rule markdown source");
  });

  it("returns an error (does not throw) for unparseable frontmatter", () => {
    const raw = ["---", "description: [unclosed", "---", "", "body"].join("\n");
    const result = extractRuleDefinitionFromMdc(raw, "/p/bad.mdc");
    expect("error" in result).toBe(true);
  });
});

describe("corpus fidelity — real .minsky/rules/*.mdc round-trip (Phase 2/3 acceptance)", () => {
  // repo root: packages/domain/src/compile → up 4 levels
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

  it("discovers the flat rule corpus and parses every rule with no skips (mt#2995)", async () => {
    const sources = await discoverRuleSources(repoRoot, realFs as unknown as MinskyCompileFsDeps);
    const mdcSources = sources.filter((s) => s.kind === "mdc");

    // Corpus sanity — the repo carries dozens of flat rules; guard against a
    // silent "discovered nothing" regression without pinning an exact count
    // (the corpus grows over time).
    expect(mdcSources.length).toBeGreaterThanOrEqual(40);

    const errors: Array<{ name: string; reason: string }> = [];
    let validCount = 0;

    for (const src of mdcSources) {
      const raw = await realFs.readFile(src.path, "utf-8");
      const result = extractRuleDefinitionFromMdc(raw, src.path);
      if ("error" in result) {
        errors.push({ name: src.name, reason: result.error });
        continue;
      }
      validCount++;
      // No content loss: every valid rule carries a non-empty description + body.
      expect(result.rule.description.length).toBeGreaterThan(0);
      expect(result.rule.content.length).toBeGreaterThan(0);
    }

    // mt#2995: `verification-checklist.mdc` gained a `description` (the one
    // previously-skipped rule from Phase 2), so the full corpus now round-trips
    // with zero skips. Any parse failure here is a reader regression.
    expect(errors).toEqual([]);
    expect(validCount).toBe(mdcSources.length);
  });
});
