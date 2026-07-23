/**
 * Unit tests for the new-pipeline claude-rules compile target (mt#2992).
 *
 * Unlike the legacy `claude-rules.test.ts` (which requires real scratch
 * directories because the legacy target hardcodes `fs/promises` with no
 * injectable seam), this target IS fs-injectable, so all tests here run
 * against a fake in-memory fs — no `custom/no-real-fs-in-tests` eslint-disable
 * needed.
 */

import { describe, it, expect } from "bun:test";
import {
  makeClaudeRulesTarget,
  buildClaudeRulesContent,
  serializeRuleToClaudeRule,
  isEligibleForClaudeRules,
  sanitizeGlobForClaudeRules,
  CLAUDE_RULES_BANNER,
} from "./claude-rules";
import type { Rule } from "../../rules/types";
import type { MinskyCompileFsDeps } from "../types";

const SOME_RULE_CONTENT = "Some rule content";

function makeRule(id: string, content: string, opts: Partial<Rule> = {}): Rule {
  return {
    id,
    content,
    format: "minsky",
    path: `/fake/.minsky/rules/${id}.mdc`,
    alwaysApply: false,
    ...opts,
  };
}

describe("claude-rules target (new pipeline): target metadata", () => {
  it("has id 'claude-rules'", () => {
    expect(makeClaudeRulesTarget().id).toBe("claude-rules");
  });

  it("declares sharedOutputDirectory: true (so --check doesn't flag hand-authored files as stale)", () => {
    expect(makeClaudeRulesTarget().sharedOutputDirectory).toBe(true);
  });

  it("defaultOutputPath returns .claude/rules/ under workspace", () => {
    expect(makeClaudeRulesTarget().defaultOutputPath("/workspace")).toBe(
      "/workspace/.claude/rules"
    );
  });
});

describe("claude-rules target (new pipeline): isEligibleForClaudeRules()", () => {
  it("excludes a rule with no globs at all", () => {
    expect(isEligibleForClaudeRules(makeRule("no-globs", SOME_RULE_CONTENT))).toBe(false);
  });

  it("excludes a rule with alwaysApply: true even if it has globs", () => {
    const rule = makeRule("always-with-globs", SOME_RULE_CONTENT, {
      globs: ["**/*.ts"],
      alwaysApply: true,
    });
    expect(isEligibleForClaudeRules(rule)).toBe(false);
  });

  it("includes a rule with non-empty globs and alwaysApply: false", () => {
    const rule = makeRule("eligible-rule", SOME_RULE_CONTENT, {
      globs: ["**/*.test.ts"],
      alwaysApply: false,
    });
    expect(isEligibleForClaudeRules(rule)).toBe(true);
  });
});

describe("claude-rules target (new pipeline): sanitizeGlobForClaudeRules()", () => {
  it("escapes a literal '[' as '\\['", () => {
    expect(sanitizeGlobForClaudeRules("src/foo[bar].ts")).toBe("src/foo\\[bar].ts");
  });

  it("does not double-escape an already-escaped bracket", () => {
    expect(sanitizeGlobForClaudeRules("photos \\[2024/**")).toBe("photos \\[2024/**");
  });
});

describe("claude-rules target (new pipeline): serializeRuleToClaudeRule()", () => {
  it("emits paths: frontmatter in flow-sequence style, then the banner, then content", () => {
    const rule = makeRule("test-rule", SOME_RULE_CONTENT, {
      globs: ["**/*.test.ts"],
      alwaysApply: false,
    });
    const md = serializeRuleToClaudeRule(rule);
    const lines = md.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe("paths: ['**/*.test.ts']");
    expect(lines[2]).toBe("---");
    expect(lines[3]).toBe(CLAUDE_RULES_BANNER);
    expect(md).toContain(SOME_RULE_CONTENT);
  });
});

describe("claude-rules target (new pipeline): buildClaudeRulesContent()", () => {
  it("includes only eligible rules in the file list", () => {
    const rules = [
      makeRule("eligible", "Content A", { globs: ["**/*.ts"], alwaysApply: false }),
      makeRule("no-globs", "Content B", { alwaysApply: false }),
      makeRule("always-apply", "Content C", { globs: ["**/*.ts"], alwaysApply: true }),
    ];
    const { files, rulesIncluded, rulesSkipped } = buildClaudeRulesContent(rules, "/output");
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("/output/eligible.md");
    expect(rulesIncluded).toEqual(["eligible"]);
    expect(rulesSkipped).toEqual(["no-globs", "always-apply"]);
  });
});

// ─── Target-level (fake fs, real .mdc source parsing + stale-file removal) ──

type FileMap = Record<string, string>;

function makeFakeFs(files: FileMap): { fs: MinskyCompileFsDeps; snapshot(): FileMap } {
  const written: FileMap = {};
  const deleted = new Set<string>();

  const fs: MinskyCompileFsDeps = {
    async readFile(path: string): Promise<string> {
      if (deleted.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      // `written` takes precedence over the initial `files` fixture so a
      // fs.writeFile() overwrite of a SOURCE path (as the stale-removal test
      // below exercises) is actually visible on the next readFile.
      const content = written[path] ?? files[path];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return content;
    },
    async writeFile(path: string, data: string): Promise<void> {
      written[path] = data;
      deleted.delete(path);
    },
    async mkdir(): Promise<undefined> {
      return undefined;
    },
    async readdir(path: string): Promise<string[]> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of [...Object.keys(files), ...Object.keys(written)]) {
        if (deleted.has(key)) continue;
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const segment = rest.split("/")[0];
          if (segment !== undefined) names.add(segment);
        }
      }
      return Array.from(names);
    },
    async access(path: string): Promise<void> {
      if (deleted.has(path) || (files[path] === undefined && written[path] === undefined)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
    },
    async chmod(): Promise<void> {},
    async unlink(path: string): Promise<void> {
      deleted.add(path);
    },
  };

  return {
    fs,
    snapshot(): FileMap {
      const out: FileMap = { ...files, ...written };
      for (const d of deleted) delete out[d];
      return out;
    },
  };
}

const WORKSPACE = "/workspace";
const OUTPUT_DIR = `${WORKSPACE}/.claude/rules`;

function ruleMdcPath(name: string): string {
  return `${WORKSPACE}/.minsky/rules/${name}.mdc`;
}

describe("claudeRulesTarget (end-to-end via fake fs + .mdc sources)", () => {
  it("listOutputFiles returns paths only for eligible rules", async () => {
    const { fs } = makeFakeFs({
      [ruleMdcPath("eligible-a")]:
        "---\ndescription: eligible\nalwaysApply: false\nglobs:\n  - '**/*.ts'\n---\nBody A\n",
      [ruleMdcPath("ineligible-b")]:
        "---\ndescription: ineligible\nalwaysApply: true\n---\nBody B\n",
    });
    const target = makeClaudeRulesTarget();
    const files = await target.listOutputFiles({}, WORKSPACE, fs);
    expect(files).toEqual([`${OUTPUT_DIR}/eligible-a.md`]);
  });

  it("writes a file only for the eligible rule", async () => {
    const { fs, snapshot } = makeFakeFs({
      [ruleMdcPath("eligible")]:
        "---\ndescription: eligible\nalwaysApply: false\nglobs:\n  - '**/*.ts'\n---\nEligible content\n",
      [ruleMdcPath("ineligible")]:
        "---\ndescription: ineligible\nalwaysApply: false\n---\nIneligible content\n",
    });
    const target = makeClaudeRulesTarget();

    const result = await target.compile({ outputPath: OUTPUT_DIR }, WORKSPACE, fs);
    expect(result.filesWritten).toEqual([`${OUTPUT_DIR}/eligible.md`]);

    const written = snapshot()[`${OUTPUT_DIR}/eligible.md`];
    expect(written).toContain("paths: ['**/*.ts']");
    expect(written).toContain("Eligible content");
  });

  it("removes a previously-generated file whose rule lost its globs (stale removal)", async () => {
    const { fs, snapshot } = makeFakeFs({
      [ruleMdcPath("shrinking-rule")]:
        "---\ndescription: shrinking\nalwaysApply: false\nglobs:\n  - '**/*.ts'\n---\nContent\n",
    });
    const target = makeClaudeRulesTarget();

    await target.compile({ outputPath: OUTPUT_DIR }, WORKSPACE, fs);
    expect(snapshot()[`${OUTPUT_DIR}/shrinking-rule.md`]).toContain("paths:");

    // Second compile: same rule, now with no globs (frontmatter changed on
    // disk). `fs` here is the in-memory fake fs built by makeFakeFs() above,
    // not real fs/promises — the lint rule matches on the `.writeFile(` call
    // shape alone and can't see through the injected receiver's type.
    // eslint-disable-next-line custom/no-real-fs-in-tests
    await fs.writeFile(
      ruleMdcPath("shrinking-rule"),
      "---\ndescription: shrinking\nalwaysApply: false\n---\nContent\n",
      "utf-8"
    );

    const result = await target.compile({ outputPath: OUTPUT_DIR }, WORKSPACE, fs);
    expect(result.filesWritten).toHaveLength(0);
    expect(snapshot()[`${OUTPUT_DIR}/shrinking-rule.md`]).toBeUndefined();
  });

  it("does NOT remove a non-generated (hand-authored) file in the output directory", async () => {
    const { fs, snapshot } = makeFakeFs({
      [ruleMdcPath("eligible")]:
        "---\ndescription: eligible\nalwaysApply: false\nglobs:\n  - '**/*.ts'\n---\nContent\n",
      [`${OUTPUT_DIR}/user-authored.md`]: "# Hand-written notes, not generated\n",
    });
    const target = makeClaudeRulesTarget();

    await target.compile({ outputPath: OUTPUT_DIR }, WORKSPACE, fs);

    expect(snapshot()[`${OUTPUT_DIR}/user-authored.md`]).toContain("Hand-written notes");
  });

  it("dry run populates contentsByPath and does not write or delete anything", async () => {
    const { fs, snapshot } = makeFakeFs({
      [ruleMdcPath("eligible")]:
        "---\ndescription: eligible\nalwaysApply: false\nglobs:\n  - '**/*.ts'\n---\nContent\n",
    });
    const target = makeClaudeRulesTarget();

    const result = await target.compile({ outputPath: OUTPUT_DIR, dryRun: true }, WORKSPACE, fs);
    expect(result.contentsByPath?.get(`${OUTPUT_DIR}/eligible.md`)).toContain("Content");
    expect(snapshot()[`${OUTPUT_DIR}/eligible.md`]).toBeUndefined();
  });
});
