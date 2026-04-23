/**
 * Unit tests for the claude-agents compile target.
 *
 * Uses injected fake fs and dynamic-import stubs to avoid touching disk.
 */

import { describe, it, expect } from "bun:test";
import { makeClaudeAgentsTarget, buildAgentMd } from "./claude-agents";
import type { MinskyCompileFsDeps } from "../types";
import type { AgentDefinition } from "../../definitions/types";

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

function agentSourcePath(agentName: string): string {
  return `${WORKSPACE}/.minsky/agents/${agentName}/agent.ts`;
}

const sampleAgent: AgentDefinition = {
  name: "my-agent",
  description: "A sample agent for testing.",
  model: "sonnet",
  prompt: "# My Agent\n\nDo something useful.\n",
};

/** Make a fake fs that has an agent.ts sentinel (content doesn't matter — it's loaded via dynamicImport). */
function makeAgentFs(...agentNames: string[]): MinskyCompileFsDeps {
  const files: FileMap = {};
  for (const name of agentNames) {
    files[agentSourcePath(name)] = "// sentinel";
  }
  return makeFakeFs(files);
}

/** Stub dynamic import: returns a module exporting the given agent as default. */
function makeImportStub(
  agentsByPath: Record<string, AgentDefinition>
): (path: string) => Promise<unknown> {
  return async (path: string) => {
    const agent = agentsByPath[path];
    if (agent === undefined) {
      throw new Error(`No stub for ${path}`);
    }
    return { default: agent };
  };
}

// ─── buildAgentMd ─────────────────────────────────────────────────────────────

describe("buildAgentMd", () => {
  it("includes name and description in frontmatter", () => {
    const md = buildAgentMd(sampleAgent);
    expect(md).toContain("name: my-agent");
    expect(md).toContain("description: A sample agent for testing.");
  });

  it("includes model when set", () => {
    const md = buildAgentMd(sampleAgent);
    expect(md).toContain("model: sonnet");
  });

  it("omits model when inherit (the default)", () => {
    const md = buildAgentMd({ ...sampleAgent, model: "inherit" });
    expect(md).not.toContain("model:");
  });

  it("omits model when not set", () => {
    const { model: _model, ...agentWithoutModel } = sampleAgent;
    const md = buildAgentMd(agentWithoutModel as AgentDefinition);
    expect(md).not.toContain("model:");
  });

  it("includes prompt body after frontmatter", () => {
    const md = buildAgentMd(sampleAgent);
    expect(md).toContain("# My Agent");
    expect(md).toContain("Do something useful.");
  });

  it("includes tools as a comma-separated string when provided", () => {
    const md = buildAgentMd({ ...sampleAgent, tools: ["Read", "Edit", "Bash"] });
    // gray-matter may quote the value since it contains commas; check for presence of all tool names
    expect(md).toContain("tools:");
    expect(md).toContain("Read");
    expect(md).toContain("Edit");
    expect(md).toContain("Bash");
  });

  it("omits tools when not provided", () => {
    const md = buildAgentMd(sampleAgent);
    expect(md).not.toContain("tools:");
  });

  it("omits tools when array is empty", () => {
    const md = buildAgentMd({ ...sampleAgent, tools: [] });
    expect(md).not.toContain("tools:");
  });

  it("includes permission-mode when set to non-default value", () => {
    const md = buildAgentMd({ ...sampleAgent, permissionMode: "auto" });
    expect(md).toContain("permission-mode: auto");
  });

  it("omits permission-mode when default", () => {
    const md = buildAgentMd({ ...sampleAgent, permissionMode: "default" });
    expect(md).not.toContain("permission-mode:");
  });

  it("includes max-turns when set", () => {
    const md = buildAgentMd({ ...sampleAgent, maxTurns: 50 });
    expect(md).toContain("max-turns: 50");
  });

  it("omits max-turns when not set", () => {
    const md = buildAgentMd(sampleAgent);
    expect(md).not.toContain("max-turns:");
  });

  it("includes skills when provided", () => {
    const md = buildAgentMd({ ...sampleAgent, skills: ["review-pr", "implement-task"] });
    expect(md).toContain("review-pr");
    expect(md).toContain("implement-task");
  });

  it("omits skills when not provided", () => {
    const md = buildAgentMd(sampleAgent);
    expect(md).not.toContain("skills:");
  });

  it("includes disallowed-tools as comma-separated string when provided", () => {
    const md = buildAgentMd({ ...sampleAgent, disallowedTools: ["Bash", "Write"] });
    // gray-matter may quote the value since it contains commas; check for presence of both tools
    expect(md).toContain("disallowed-tools:");
    expect(md).toContain("Bash");
    expect(md).toContain("Write");
  });
});

// ─── listOutputFiles ──────────────────────────────────────────────────────────

describe("claudeAgentsTarget.listOutputFiles", () => {
  it("returns empty list when no agents exist", async () => {
    const target = makeClaudeAgentsTarget();
    const fakeFs = makeFakeFs({});
    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toEqual([]);
  });

  it("returns one .md path per agent directory", async () => {
    const target = makeClaudeAgentsTarget();
    const fakeFs = makeAgentFs("my-agent", "other-agent");

    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith(".md"))).toBe(true);
    expect(files.some((f) => f.includes("my-agent"))).toBe(true);
    expect(files.some((f) => f.includes("other-agent"))).toBe(true);
  });

  it("output paths are directly under .claude/agents/ (not nested)", async () => {
    const target = makeClaudeAgentsTarget();
    const fakeFs = makeAgentFs("my-agent");

    const files = await target.listOutputFiles({}, WORKSPACE, fakeFs);
    expect(files).toHaveLength(1);
    // Should be .claude/agents/my-agent.md, NOT .claude/agents/my-agent/something.md
    expect(files[0]).toMatch(/\.claude\/agents\/my-agent\.md$/);
  });
});

// ─── compile — normal mode ────────────────────────────────────────────────────

describe("claudeAgentsTarget.compile (normal)", () => {
  it("writes agent .md for each discovered agent", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeAgentFs("my-agent"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({ [agentSourcePath("my-agent")]: sampleAgent });
    const target = makeClaudeAgentsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsIncluded).toEqual(["my-agent"]);
    expect(result.definitionsSkipped).toEqual([]);
    expect(result.filesWritten).toHaveLength(1);
    expect(result.content).toBeUndefined();

    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    expect(outPath).toContain("my-agent");
    expect(outPath).toEndWith(".md");
    expect(written[outPath]).toContain("name: my-agent");
  });

  it("skips an agent whose import throws", async () => {
    const fakeFs = makeAgentFs("bad-agent");
    const importStub = async () => {
      throw new Error("module not found");
    };
    const target = makeClaudeAgentsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["bad-agent"]);
    expect(result.definitionsIncluded).toEqual([]);
  });

  it("skips an agent that fails schema validation", async () => {
    const fakeFs = makeAgentFs("invalid-agent");
    // Return a module with an invalid default (missing required fields)
    const importStub = async (_path: string) => ({ default: { name: 123 } });
    const target = makeClaudeAgentsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);
    expect(result.definitionsSkipped).toEqual(["invalid-agent"]);
  });

  it("skips an agent when dirName !== agent.name (invariant enforcement)", async () => {
    // Compile enforces dirName === agent.name so that listOutputFiles
    // (which only sees dirNames) and the compile output paths agree. When they
    // differ, the agent is skipped. This preserves the Claude Code invariant
    // that filename stem matches the frontmatter `name`.
    const fakeFs = makeAgentFs("dir-name-x");
    const agentWithDifferentName: AgentDefinition = { ...sampleAgent, name: "agent-name-y" };
    const importStub = makeImportStub({
      [agentSourcePath("dir-name-x")]: agentWithDifferentName,
    });
    const target = makeClaudeAgentsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsSkipped).toEqual(["dir-name-x"]);
    expect(result.definitionsIncluded).toEqual([]);
    expect(result.filesWritten).toEqual([]);
  });

  it("produces output at .claude/agents/<name>.md when dirName === agent.name", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeAgentFs("my-agent"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({
      [agentSourcePath("my-agent")]: { ...sampleAgent, name: "my-agent" },
    });
    const target = makeClaudeAgentsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.filesWritten).toHaveLength(1);
    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    expect(outPath).toMatch(/\.claude\/agents\/my-agent\.md$/);
  });

  it("compiles multiple agents and writes them individually", async () => {
    const written: Record<string, string> = {};
    const agentA: AgentDefinition = { ...sampleAgent, name: "agent-a" };
    const agentB: AgentDefinition = { ...sampleAgent, name: "agent-b" };
    const fakeFs: MinskyCompileFsDeps = {
      ...makeAgentFs("agent-a", "agent-b"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({
      [agentSourcePath("agent-a")]: agentA,
      [agentSourcePath("agent-b")]: agentB,
    });
    const target = makeClaudeAgentsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsIncluded).toHaveLength(2);
    expect(result.filesWritten).toHaveLength(2);
    expect(result.definitionsSkipped).toEqual([]);
  });
});

// ─── compile — dryRun mode ────────────────────────────────────────────────────

describe("claudeAgentsTarget.compile (dryRun)", () => {
  it("does not write files and populates content and contentsByPath", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeAgentFs("my-agent"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const importStub = makeImportStub({ [agentSourcePath("my-agent")]: sampleAgent });
    const target = makeClaudeAgentsTarget(importStub);

    const result = await target.compile({ dryRun: true }, WORKSPACE, fakeFs);

    expect(Object.keys(written)).toHaveLength(0);
    expect(result.content).toBeDefined();
    expect(result.contentsByPath).toBeDefined();

    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    if (result.contentsByPath === undefined)
      throw new Error("expected contentsByPath to be defined");
    expect(result.contentsByPath.get(outPath)).toContain("name: my-agent");
  });
});

// ─── suggestedSubagentType — schema + compile ─────────────────────────────────

/** Frontmatter key as authored in TypeScript (camelCase) — must NOT appear in compiled output. */
const SUGGESTED_SUBAGENT_TYPE_CAMEL = "suggestedSubagentType";
/** Frontmatter key as kebab-case — must NOT appear in compiled output. */
const SUGGESTED_SUBAGENT_TYPE_KEBAB = "suggested-subagent-type";
/** Shared skill name used across both refactorer and cleaner fixtures. */
const SKILL_CODE_ORGANIZATION = "code-organization";

describe("suggestedSubagentType — schema acceptance and compile omission", () => {
  it("agentDefinitionSchema accepts suggestedSubagentType", () => {
    const { agentDefinitionSchema } = require("../../definitions/schemas");
    const result = agentDefinitionSchema.safeParse({
      name: "test-agent",
      description: "A test agent.",
      model: "sonnet",
      suggestedSubagentType: "refactor",
      prompt: "# Test\n",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.suggestedSubagentType).toBe("refactor");
    }
  });

  it("agentDefinitionSchema accepts an agent without suggestedSubagentType", () => {
    const { agentDefinitionSchema } = require("../../definitions/schemas");
    const result = agentDefinitionSchema.safeParse({
      name: "test-agent",
      description: "A test agent.",
      model: "sonnet",
      prompt: "# Test\n",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.suggestedSubagentType).toBeUndefined();
    }
  });

  it("buildAgentMd does NOT emit suggestedSubagentType in frontmatter", () => {
    const agentWithSubagentType: AgentDefinition = {
      ...sampleAgent,
      suggestedSubagentType: "refactor",
    };
    const md = buildAgentMd(agentWithSubagentType);
    expect(md).not.toContain(SUGGESTED_SUBAGENT_TYPE_CAMEL);
    expect(md).not.toContain(SUGGESTED_SUBAGENT_TYPE_KEBAB);
    expect(md).not.toContain("refactor");
  });

  it("compile does NOT emit suggestedSubagentType in compiled .md output", async () => {
    const written: Record<string, string> = {};
    const fakeFs: MinskyCompileFsDeps = {
      ...makeAgentFs("refactorer"),
      async writeFile(path: string, data: string): Promise<void> {
        written[path] = data;
      },
    };

    const refactorerAgent: AgentDefinition = {
      name: "refactorer",
      description: "Structural refactoring agent.",
      model: "sonnet",
      skills: [SKILL_CODE_ORGANIZATION, "testing-guide"],
      suggestedSubagentType: "refactor",
      prompt: "# Refactorer\n\nDo refactoring.\n",
    };

    const importStub = makeImportStub({ [agentSourcePath("refactorer")]: refactorerAgent });
    const target = makeClaudeAgentsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsIncluded).toEqual(["refactorer"]);
    const outPath = result.filesWritten[0];
    if (outPath === undefined) throw new Error("expected filesWritten[0] to be defined");
    const content = written[outPath];
    if (content === undefined) throw new Error("expected written content to be defined");
    expect(content).not.toContain(SUGGESTED_SUBAGENT_TYPE_CAMEL);
    expect(content).not.toContain(SUGGESTED_SUBAGENT_TYPE_KEBAB);
  });
});

// ─── 5 core agent definitions — compile correctness ───────────────────────────

describe("5 core agent definitions — compile correctness", () => {
  const coreAgents: AgentDefinition[] = [
    {
      name: "implementer",
      description: "Full-cycle implementation agent.",
      model: "sonnet",
      skills: ["implement-task", "prepare-pr", "testing-guide", "error-handling"],
      prompt: "# Implementer\n\nImplement tasks.\n",
    },
    {
      name: "reviewer",
      description: "Read-only code review agent.",
      model: "sonnet",
      skills: ["review-pr"],
      tools: ["Read", "Glob", "Grep", "Bash"],
      prompt: "# Reviewer\n\nReview code.\n",
    },
    {
      name: "refactorer",
      description: "Structural refactoring agent.",
      model: "sonnet",
      skills: [SKILL_CODE_ORGANIZATION, "testing-guide"],
      suggestedSubagentType: "refactor",
      prompt: "# Refactorer\n\nRefactor code.\n",
    },
    {
      name: "cleaner",
      description: "Technical debt cleanup agent.",
      model: "sonnet",
      skills: [SKILL_CODE_ORGANIZATION, "fix-skipped-tests"],
      prompt: "# Cleaner\n\nClean up code.\n",
    },
    {
      name: "auditor",
      description: "Spec-verification agent.",
      model: "sonnet",
      skills: [],
      tools: [
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "mcp__minsky__tasks_get",
        "mcp__minsky__tasks_spec_get",
      ],
      suggestedSubagentType: "verify-completion",
      prompt: "# Auditor\n\nVerify specs.\n",
    },
  ];

  for (const agent of coreAgents) {
    const agentName = agent.name;

    it(`${agentName}: compiles successfully and produces .md output`, async () => {
      const written: Record<string, string> = {};
      const fakeFs: MinskyCompileFsDeps = {
        ...makeAgentFs(agentName),
        async writeFile(path: string, data: string): Promise<void> {
          written[path] = data;
        },
      };

      const importStub = makeImportStub({ [agentSourcePath(agentName)]: agent });
      const target = makeClaudeAgentsTarget(importStub);

      const result = await target.compile({}, WORKSPACE, fakeFs);

      expect(result.definitionsIncluded).toEqual([agentName]);
      expect(result.definitionsSkipped).toEqual([]);
      expect(result.filesWritten).toHaveLength(1);
      const outPath = result.filesWritten[0];
      if (outPath === undefined) throw new Error("expected filesWritten[0]");
      expect(outPath).toMatch(new RegExp(`\\.claude/agents/${agentName}\\.md$`));
    });

    it(`${agentName}: compiled frontmatter contains correct name`, async () => {
      const md = buildAgentMd(agent);
      expect(md).toContain(`name: ${agentName}`);
    });

    it(`${agentName}: compiled frontmatter does NOT contain suggestedSubagentType`, async () => {
      const md = buildAgentMd(agent);
      expect(md).not.toContain(SUGGESTED_SUBAGENT_TYPE_CAMEL);
      expect(md).not.toContain(SUGGESTED_SUBAGENT_TYPE_KEBAB);
    });

    if (agent.skills !== undefined && agent.skills.length > 0) {
      it(`${agentName}: compiled frontmatter contains correct skills`, async () => {
        const md = buildAgentMd(agent);
        expect(md).toContain("skills:");
        for (const skill of agent.skills ?? []) {
          expect(md).toContain(skill);
        }
      });
    }
  }

  it("dirName !== agent.name causes compile to skip the agent (invariant)", async () => {
    const fakeFs = makeAgentFs("reviewer");
    // Agent with a different name than the directory
    const agentWithWrongName: AgentDefinition = {
      name: "impl",
      description: "Wrong name.",
      model: "sonnet",
      prompt: "# Wrong\n",
    };
    const importStub = makeImportStub({ [agentSourcePath("reviewer")]: agentWithWrongName });
    const target = makeClaudeAgentsTarget(importStub);

    const result = await target.compile({}, WORKSPACE, fakeFs);

    expect(result.definitionsSkipped).toEqual(["reviewer"]);
    expect(result.definitionsIncluded).toEqual([]);
  });
});
