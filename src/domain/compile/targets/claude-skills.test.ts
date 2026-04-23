/**
 * Unit tests for the claude-skills compile target.
 *
 * Uses injected fake fs and dynamic-import stubs to avoid touching disk.
 */

import { describe, it, expect } from "bun:test";
import { makeClaudeSkillsTarget, buildSkillMd } from "./claude-skills";
import type { MinskyCompileFsDeps } from "../types";
import type { SkillDefinition } from "../../definitions/types";

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
