/**
 * Unit tests for the claude-skills compile target.
 *
 * Uses injected fake fs and dynamic-import stubs to avoid touching disk.
 */

import { describe, it, expect } from "bun:test";
import { makeClaudeSkillsTarget, buildSkillMd } from "./claude-skills";
import type { MinskyCompileFsDeps } from "../types";
import type { SkillDefinition } from "../../definitions/types";
import {
  COMPILE_GENERATED_BANNER,
  GENERATION_BANNER_PATTERNS,
} from "../../rules/compile/banner-constants";

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

function skillSourcePath(skillName: string): string {
  return `${WORKSPACE}/.minsky/skills/${skillName}/skill.ts`;
}

const sampleSkill: SkillDefinition = {
  name: "my-skill",
  description: "A sample skill for testing.",
  content: "# My Skill\n\nDo something useful.\n",
  userInvocable: true,
};

/** Make a fake fs that has a skill.ts sentinel (content doesn't matter — it's loaded via dynamicImport). */
function makeSkillFs(...skillNames: string[]): MinskyCompileFsDeps {
  const files: FileMap = {};
  for (const name of skillNames) {
    files[skillSourcePath(name)] = "// sentinel";
  }
  return makeFakeFs(files);
}

/** Stub dynamic import: returns a module exporting the given skill as default. */
function makeImportStub(
  skillsByPath: Record<string, SkillDefinition>
): (path: string) => Promise<unknown> {
  return async (path: string) => {
    const skill = skillsByPath[path];
    if (skill === undefined) {
      throw new Error(`No stub for ${path}`);
    }
    return { default: skill };
  };
}

// ─── buildSkillMd ─────────────────────────────────────────────────────────────

describe("buildSkillMd", () => {
  it("includes name and description in frontmatter", () => {
    const md = buildSkillMd(sampleSkill);
    expect(md).toContain("name: my-skill");
    expect(md).toContain("description: A sample skill for testing.");
  });

  it("includes user-invocable in frontmatter", () => {
    const md = buildSkillMd(sampleSkill);
    expect(md).toContain("user-invocable: true");
  });

  it("includes content body after frontmatter", () => {
    const md = buildSkillMd(sampleSkill);
    expect(md).toContain("# My Skill");
    expect(md).toContain("Do something useful.");
  });

  it("emits the generation banner as a YAML comment on line 2 (mt#2252)", () => {
    const md = buildSkillMd(sampleSkill);
    const lines = md.split("\n");
    // Line 1 must remain the frontmatter opener; banner goes on line 2.
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe(COMPILE_GENERATED_BANNER);
  });

  it("banner lands within the first 5 lines so the edit-guard hook detects it", () => {
    const md = buildSkillMd(sampleSkill);
    const firstFive = md.split("\n").slice(0, 5).join("\n");
    const matched = GENERATION_BANNER_PATTERNS.some(({ re }) => re.test(firstFive));
    expect(matched).toBe(true);
  });

  it("banner does not break YAML frontmatter parsing (name/description still parse)", async () => {
    const matter = (await import("gray-matter")).default;
    const parsed = matter(buildSkillMd(sampleSkill));
    expect(parsed.data["name"]).toBe("my-skill");
    expect(parsed.data["description"]).toBe("A sample skill for testing.");
  });

  it("omits disable-model-invocation when false", () => {
    const md = buildSkillMd({ ...sampleSkill, disableModelInvocation: false });
    expect(md).not.toContain("disable-model-invocation");
  });

  it("includes disable-model-invocation when true", () => {
    const md = buildSkillMd({ ...sampleSkill, disableModelInvocation: true });
    expect(md).toContain("disable-model-invocation: true");
  });

  it("includes tags when provided", () => {
    const md = buildSkillMd({ ...sampleSkill, tags: ["alpha", "beta"] });
    expect(md).toContain("alpha");
    expect(md).toContain("beta");
  });

  it("omits tags key when tags is empty array", () => {
    const md = buildSkillMd({ ...sampleSkill, tags: [] });
    expect(md).not.toContain("tags:");
  });

  it("includes allowed-tools when provided", () => {
    const md = buildSkillMd({ ...sampleSkill, allowedTools: ["Bash", "Read"] });
    expect(md).toContain("allowed-tools");
    expect(md).toContain("Bash");
  });
});

// ─── listOutputFiles ──────────────────────────────────────────────────────────

describe("claudeSkillsTarget.listOutputFiles", () => {
  it("returns empty list when no skills exist", async () => {
    const target = makeClaudeSkillsTarget();
    const fakeFs = makeFakeFs({});
    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toEqual([]);
  });

  it("returns one SKILL.md path per skill directory", async () => {
    const target = makeClaudeSkillsTarget();
    const fakeFs = makeSkillFs("my-skill", "other-skill");

    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith("SKILL.md"))).toBe(true);
    expect(files.some((f) => f.includes("my-skill"))).toBe(true);
    expect(files.some((f) => f.includes("other-skill"))).toBe(true);
  });
});

// ─── compile — normal mode ────────────────────────────────────────────────────

describe("claudeSkillsTarget.compile (normal)", () => {
  it("writes SKILL.md for each discovered skill", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeSkillFs("my-skill"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({ [skillSourcePath("my-skill")]: sampleSkill });
    const target = makeClaudeSkillsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsIncluded).toEqual(["my-skill"]);
    expect(result.definitionsSkipped).toEqual([]);
    expect(result.filesWritten).toHaveLength(1);
    expect(result.content).toBeUndefined();

    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    expect(outPath).toContain("my-skill");
    expect(outPath).toContain("SKILL.md");
    expect(written[outPath]).toContain("name: my-skill");
  });

  it("skips a skill whose import throws", async () => {
    const fakeFs = makeSkillFs("bad-skill");
    const importStub = async () => {
      throw new Error("module not found");
    };
    const target = makeClaudeSkillsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["bad-skill"]);
    expect(result.definitionsIncluded).toEqual([]);
  });

  it("skips a skill that fails schema validation", async () => {
    const fakeFs = makeSkillFs("invalid-skill");
    // Return a module with an invalid default (missing required fields)
    const importStub = async (_path: string) => ({ default: { name: 123 } });
    const target = makeClaudeSkillsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["invalid-skill"]);
  });

  // mt#2182: the originating failure was that import errors were swallowed
  // silently (`catch {}`), so all 7 skills skipped with no warning. These
  // tests assert the skip is now reported (via the injected onSkip sink, whose
  // production default is log.warn) with the skill name + the actual error.
  it("reports a warning (not a silent skip) when a skill import throws", async () => {
    const skips: string[] = [];
    const fakeFs = makeSkillFs("bad-skill");
    const importStub = async () => {
      throw new Error("module not found: boom");
    };
    const target = makeClaudeSkillsTarget(importStub, (m) => skips.push(m));

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["bad-skill"]);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("bad-skill");
    expect(skips[0]).toContain("module not found: boom");
  });

  it("reports a warning (not a silent skip) when a skill fails schema validation", async () => {
    const skips: string[] = [];
    const fakeFs = makeSkillFs("invalid-skill");
    const importStub = async (_path: string) => ({ default: { name: 123 } });
    const target = makeClaudeSkillsTarget(importStub, (m) => skips.push(m));

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["invalid-skill"]);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("invalid-skill");
  });
});

// ─── compile — dryRun mode ────────────────────────────────────────────────────

describe("claudeSkillsTarget.compile (dryRun)", () => {
  it("does not write files and populates content and contentsByPath", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeSkillFs("my-skill"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({ [skillSourcePath("my-skill")]: sampleSkill });
    const target = makeClaudeSkillsTarget(importStub);

    const result = await target.compile({ dryRun: true }, WORKSPACE, fakeFs);

    expect(Object.keys(written)).toHaveLength(0);
    expect(result.content).toBeDefined();
    expect(result.contentsByPath).toBeDefined();

    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    if (result.contentsByPath === undefined)
      throw new Error("expected contentsByPath to be defined");
    expect(result.contentsByPath.get(outPath)).toContain("name: my-skill");
  });
});

// ─── compile — markdown source path (mt#2279) ──────────────────────────────────

function mdSourcePath(skillName: string): string {
  return `${WORKSPACE}/.minsky/skills/${skillName}/SKILL.md`;
}

const sampleMdSource = `---
name: md-skill
description: A markdown-authored skill.
user-invocable: true
---

# MD Skill

Body content here.
`;

/** An import stub that fails loudly if invoked — markdown skills must NOT import. */
const neverImport = async (path: string): Promise<unknown> => {
  throw new Error(`dynamicImport should not be called for a markdown source: ${path}`);
};

describe("claudeSkillsTarget.compile (markdown source — mt#2279)", () => {
  it("compiles a SKILL.md source (no skill.ts) to a banner-bearing output", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeFakeFs({ [mdSourcePath("md-skill")]: sampleMdSource }),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const target = makeClaudeSkillsTarget(neverImport);
    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsIncluded).toEqual(["md-skill"]);
    expect(result.definitionsSkipped).toEqual([]);

    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    expect(outPath).toContain("/.claude/skills/md-skill/SKILL.md");
    const out = written[outPath];
    if (out === undefined) throw new Error("expected output to be written");
    const lines = out.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe(COMPILE_GENERATED_BANNER);
    expect(out).toContain("name: md-skill");
    expect(out).toContain("# MD Skill");
    expect(out).toContain("Body content here.");
  });

  it("listOutputFiles includes markdown-sourced skill dirs", async () => {
    const fakeFs = makeFakeFs({ [mdSourcePath("md-skill")]: sampleMdSource });
    const target = makeClaudeSkillsTarget(neverImport);
    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("/.claude/skills/md-skill/SKILL.md");
  });

  it("TS and markdown both present → skip + warn (ambiguous canonical source)", async () => {
    const skips: string[] = [];
    const fakeFs = makeFakeFs({
      [skillSourcePath("dual")]: "// sentinel",
      [mdSourcePath("dual")]: sampleMdSource,
    });
    // dynamicImport would succeed for the .ts, but the dir must be skipped before that.
    const importStub = makeImportStub({ [skillSourcePath("dual")]: sampleSkill });
    const target = makeClaudeSkillsTarget(importStub, (m) => skips.push(m));

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["dual"]);
    expect(result.definitionsIncluded).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("dual");
    expect(skips[0]).toContain("ambiguous");
  });

  it("malformed markdown (missing required name) → skip + warn", async () => {
    const skips: string[] = [];
    const badMd = `---\ndescription: Missing the name field.\n---\n\n# Body\n`;
    const fakeFs = makeFakeFs({ [mdSourcePath("bad-md")]: badMd });
    const target = makeClaudeSkillsTarget(neverImport, (m) => skips.push(m));

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["bad-md"]);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("bad-md");
  });

  it("applies schema defaults when MD omits user-invocable / disable-model-invocation", async () => {
    const written: Record<string, string> = {};
    const minimalMd = `---\nname: minimal-md\ndescription: Minimal markdown skill.\n---\n\n# Minimal\n\nBody.\n`;
    const fakeFs: MinskyCompileFsDeps = {
      ...makeFakeFs({ [mdSourcePath("minimal-md")]: minimalMd }),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };
    const target = makeClaudeSkillsTarget(neverImport);

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsIncluded).toEqual(["minimal-md"]);
    const out = written[result.filesWritten[0] ?? ""];
    if (out === undefined) throw new Error("expected output to be written");
    // userInvocable defaults to true; disableModelInvocation defaults to false (omitted from output)
    expect(out).toContain("user-invocable: true");
    expect(out).not.toContain("disable-model-invocation");
  });

  it("normalizes a scalar `tags` frontmatter value into an array", async () => {
    const written: Record<string, string> = {};
    const scalarTagsMd = `---\nname: scalar-tags\ndescription: Skill with a scalar tag.\ntags: alpha\n---\n\n# Body\n`;
    const fakeFs: MinskyCompileFsDeps = {
      ...makeFakeFs({ [mdSourcePath("scalar-tags")]: scalarTagsMd }),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };
    const target = makeClaudeSkillsTarget(neverImport);

    const result = await target.compile({}, WORKSPACE, fakeFs);
    // Without scalar→array normalization this would fail schema validation and skip.
    expect(result.definitionsIncluded).toEqual(["scalar-tags"]);
    const out = written[result.filesWritten[0] ?? ""];
    if (out === undefined) throw new Error("expected output to be written");
    expect(out).toContain("alpha");
  });

  it("listOutputFiles excludes ambiguous (both-source) dirs", async () => {
    const fakeFs = makeFakeFs({
      [skillSourcePath("dual")]: "// sentinel",
      [mdSourcePath("dual")]: sampleMdSource,
    });
    const target = makeClaudeSkillsTarget(neverImport);
    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    // "dual" has both sources → compile skips it → listOutputFiles must not list it
    expect(files).toEqual([]);
  });
});
