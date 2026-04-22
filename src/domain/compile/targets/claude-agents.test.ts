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
