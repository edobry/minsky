import { describe, it, expect } from "bun:test";
import {
  generateSubagentPrompt,
  PROMPT_WATERMARK,
  ENVELOPE_HEADER,
  type GeneratePromptParams,
} from "../../../src/domain/session/prompt-generation";

const MCP_SESSION_COMMIT = "mcp__minsky__session_commit";
const MCP_SESSION_PR_CREATE = "mcp__minsky__session_pr_create";
const EXPECTED_MODEL = "sonnet";

const baseParams: GeneratePromptParams = {
  sessionDir: "/Users/test/.local/state/minsky/sessions/abc-123",
  sessionId: "abc-123",
  taskId: "456",
  type: "implementation",
  instructions: "Add a new feature to do X.",
};

describe("generateSubagentPrompt", () => {
  describe("common sections", () => {
    it("includes the session directory in the prompt", () => {
      const result = generateSubagentPrompt(baseParams);
      expect(result.prompt).toContain(baseParams.sessionDir);
    });

    it("includes the task ID in the prompt header", () => {
      const result = generateSubagentPrompt(baseParams);
      expect(result.prompt).toContain("mt#456");
    });

    it("includes the caller's instructions in the prompt", () => {
      const result = generateSubagentPrompt(baseParams);
      expect(result.prompt).toContain("Add a new feature to do X.");
    });

    it("includes absolute path requirement", () => {
      const result = generateSubagentPrompt(baseParams);
      expect(result.prompt).toContain("All file paths MUST be absolute paths under this directory");
    });
  });

  describe("implementation type", () => {
    it("includes commit instructions with sessionId", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "implementation" });
      expect(result.prompt).toContain(MCP_SESSION_COMMIT);
      expect(result.prompt).toContain(`sessionId: "${baseParams.sessionId}"`);
      expect(result.prompt).toContain("all: true");
    });

    it("includes PR instructions with task", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "implementation" });
      expect(result.prompt).toContain(MCP_SESSION_PR_CREATE);
      expect(result.prompt).toContain(`task: "mt#${baseParams.taskId}"`);
    });

    it("includes 'Do NOT merge' instruction", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "implementation" });
      expect(result.prompt).toContain("Do NOT merge the PR");
    });

    it("includes no-bash instruction", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "implementation" });
      expect(result.prompt).toContain(
        "Do NOT run Bash commands for formatting, linting, type-checking, or tests"
      );
    });

    it("suggests sonnet as the model for implementation", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "implementation" });
      expect(result.suggestedModel).toBe(EXPECTED_MODEL);
    });

    it("does not suggest a subagent type for implementation", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "implementation" });
      expect(result.agentType).toBeUndefined();
    });
  });

  describe("refactor type", () => {
    it("includes coherence verification reminder", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "refactor" });
      expect(result.prompt).toContain("re-read each modified file end-to-end");
      expect(result.prompt).toContain("no stale comments, no dead exports, no orphan code");
    });

    it("includes commit and PR instructions", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "refactor" });
      expect(result.prompt).toContain(MCP_SESSION_COMMIT);
      expect(result.prompt).toContain(MCP_SESSION_PR_CREATE);
    });

    it("suggests refactorer agentType", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "refactor" });
      expect(result.agentType).toBe("refactorer");
    });

    it("suggests sonnet as the model for refactor", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "refactor" });
      expect(result.suggestedModel).toBe(EXPECTED_MODEL);
    });
  });

  describe("review type", () => {
    it("omits commit instructions", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "review" });
      expect(result.prompt).not.toContain(MCP_SESSION_COMMIT);
    });

    it("omits PR instructions", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "review" });
      expect(result.prompt).not.toContain(MCP_SESSION_PR_CREATE);
    });

    it("includes 'Report findings' instruction", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "review" });
      expect(result.prompt).toContain("Report findings as structured output");
    });

    it("includes 'Do NOT make any changes' instruction", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "review" });
      expect(result.prompt).toContain("Do NOT make any changes");
    });

    it("suggests sonnet as the model for review", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "review" });
      expect(result.suggestedModel).toBe(EXPECTED_MODEL);
    });

    it("does not suggest a subagent type for review", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "review" });
      expect(result.agentType).toBeUndefined();
    });
  });

  describe("cleanup type", () => {
    it("includes batching guidance", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "cleanup" });
      expect(result.prompt).toContain("commit after each batch of ~10 files");
    });

    it("includes commit and PR instructions", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "cleanup" });
      expect(result.prompt).toContain(MCP_SESSION_COMMIT);
      expect(result.prompt).toContain(MCP_SESSION_PR_CREATE);
    });

    it("suggests sonnet as the model for cleanup", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "cleanup" });
      expect(result.suggestedModel).toBe(EXPECTED_MODEL);
    });

    it("does not suggest a subagent type for cleanup", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "cleanup" });
      expect(result.agentType).toBeUndefined();
    });
  });

  describe("audit type", () => {
    it("omits commit instructions", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "audit" });
      expect(result.prompt).not.toContain(MCP_SESSION_COMMIT);
    });

    it("omits PR instructions", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "audit" });
      expect(result.prompt).not.toContain(MCP_SESSION_PR_CREATE);
    });

    it("includes audit instructions with Met/Not met/Not applicable format", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "audit" });
      expect(result.prompt).toContain("Audit Instructions");
      expect(result.prompt).toContain("**Met**");
      expect(result.prompt).toContain("**Not met**");
      expect(result.prompt).toContain("**Not applicable**");
    });

    it("suggests auditor agentType", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "audit" });
      expect(result.agentType).toBe("auditor");
    });

    it("suggests sonnet as the model for audit", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "audit" });
      expect(result.suggestedModel).toBe(EXPECTED_MODEL);
    });
  });

  describe("skill references", () => {
    it("includes implement-task and prepare-pr skills for implementation type", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "implementation" });
      expect(result.prompt).toContain("/implement-task");
      expect(result.prompt).toContain("/prepare-pr");
    });

    it("includes code-organization skill for refactor type", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "refactor" });
      expect(result.prompt).toContain("/code-organization");
    });

    it("includes review-pr skill for review type", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "review" });
      expect(result.prompt).toContain("/review-pr");
    });

    it("includes fix-skipped-tests skill for cleanup type", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "cleanup" });
      expect(result.prompt).toContain("/fix-skipped-tests");
    });

    it("does not include skill references for audit type", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "audit" });
      expect(result.prompt).not.toContain("Recommended Skills");
    });

    it("skill references appear before scope constraints", () => {
      const scope = ["src/foo.ts"];
      const result = generateSubagentPrompt({ ...baseParams, type: "implementation", scope });
      const skillsIdx = result.prompt.indexOf("Recommended Skills");
      const scopeIdx = result.prompt.indexOf("Scope Constraints");
      expect(skillsIdx).toBeGreaterThan(-1);
      expect(scopeIdx).toBeGreaterThan(-1);
      expect(skillsIdx).toBeLessThan(scopeIdx);
    });
  });

  describe("scope handling", () => {
    it("lists files in the prompt when scope is provided", () => {
      const scope = ["src/foo.ts", "src/bar.ts"];
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.prompt).toContain("src/foo.ts");
      expect(result.prompt).toContain("src/bar.ts");
    });

    it("does not include scope section when scope is not provided", () => {
      const result = generateSubagentPrompt({ ...baseParams, scope: undefined });
      expect(result.prompt).not.toContain("Scope Constraints");
    });

    it("does not produce a scope warning for 40 files", () => {
      const scope = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.scopeWarning).toBeUndefined();
    });

    it("produces a scope warning for more than 40 files", () => {
      const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.scopeWarning).toBeDefined();
      expect(result.scopeWarning).toContain("41");
    });

    it("scope warning mentions batching", () => {
      const scope = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.scopeWarning).toContain("batching");
    });
  });

  describe("scope batching (>40 files)", () => {
    it("does not batch when scope is exactly 40 files", () => {
      const scope = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.batches).toBeUndefined();
      expect(result.scopeWarning).toBeUndefined();
    });

    it("batches 41 files into 2 batches (30 + 11)", () => {
      const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.batches).toBeDefined();
      expect(result.batches?.length).toBe(2);
    });

    it("batches 90 files into 3 batches (30 + 30 + 30)", () => {
      const scope = Array.from({ length: 90 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.batches).toBeDefined();
      expect(result.batches?.length).toBe(3);
    });

    it("each batch prompt contains the correct batch number", () => {
      const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.batches?.[0]?.prompt).toContain("Batch 1 of 2");
      expect(result.batches?.[1]?.prompt).toContain("Batch 2 of 2");
    });

    it("each batch prompt contains only its own files in the scope section", () => {
      const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      // Batch 1: files 0-29
      expect(result.batches?.[0]?.prompt).toContain("src/file0.ts");
      expect(result.batches?.[0]?.prompt).toContain("src/file29.ts");
      expect(result.batches?.[0]?.prompt).not.toContain("src/file30.ts");
      // Batch 2: files 30-40
      expect(result.batches?.[1]?.prompt).toContain("src/file30.ts");
      expect(result.batches?.[1]?.prompt).toContain("src/file40.ts");
      expect(result.batches?.[1]?.prompt).not.toContain("src/file0.ts");
    });

    it("non-final batches include intermediate commit instructions", () => {
      const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.batches?.[0]?.prompt).toContain(
        "Commit this batch before proceeding to the next"
      );
    });

    it("final batch includes full commit and PR instructions instead of intermediate", () => {
      const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      const lastBatch = result.batches?.[result.batches.length - 1];
      expect(lastBatch?.prompt).not.toContain("Commit this batch before proceeding to the next");
      expect(lastBatch?.prompt).toContain(MCP_SESSION_PR_CREATE);
    });

    it("primary prompt matches the first batch prompt", () => {
      const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.batches).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.prompt).toBe(result.batches![0]!.prompt);
    });

    it("each batch has correct batchIndex and totalBatches", () => {
      const scope = Array.from({ length: 90 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      result.batches?.forEach((batch, idx) => {
        expect(batch.batchIndex).toBe(idx + 1);
        expect(batch.totalBatches).toBe(3);
      });
    });

    it("sets scopeWarning explaining the batching", () => {
      const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.scopeWarning).toBeDefined();
      expect(result.scopeWarning).toContain("41");
    });

    it("includes watermark in each batch prompt", () => {
      const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
      const result = generateSubagentPrompt({ ...baseParams, scope });
      expect(result.batches).toBeDefined();
      for (const batch of result.batches ?? []) {
        expect(batch.prompt).toContain(PROMPT_WATERMARK);
      }
    });
  });

  describe("watermark", () => {
    it("includes watermark in implementation prompts", () => {
      const result = generateSubagentPrompt(baseParams);
      expect(result.prompt).toContain(PROMPT_WATERMARK);
    });

    it("includes watermark in refactor prompts", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "refactor" });
      expect(result.prompt).toContain(PROMPT_WATERMARK);
    });

    it("includes watermark in review prompts", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "review" });
      expect(result.prompt).toContain(PROMPT_WATERMARK);
    });

    it("includes watermark in cleanup prompts", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "cleanup" });
      expect(result.prompt).toContain(PROMPT_WATERMARK);
    });

    it("includes watermark in audit prompts", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "audit" });
      expect(result.prompt).toContain(PROMPT_WATERMARK);
    });
  });

  describe("operating envelope", () => {
    const MUTATING_TYPES = ["implementation", "refactor", "cleanup"] as const;
    const READ_ONLY_TYPES = ["review", "audit"] as const;
    const ALL_TYPES = [...MUTATING_TYPES, ...READ_ONLY_TYPES] as const;

    const EXPECTED_HANDOFF_PATH = `.minsky/sessions/${baseParams.sessionId}/handoff.md`;

    describe("default (envelope included)", () => {
      for (const type of ALL_TYPES) {
        it(`includes the envelope header for ${type}`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          expect(result.prompt).toContain(ENVELOPE_HEADER);
        });

        it(`includes budget-awareness framing for ${type}`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          expect(result.prompt).toContain("**Budget awareness.**");
          expect(result.prompt).toContain("24 and 65 tool uses");
        });

        it(`includes graceful-exit section for ${type}`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          expect(result.prompt).toContain("**Graceful exit.**");
        });

        it(`includes the literal handoff path for ${type}`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          expect(result.prompt).toContain(EXPECTED_HANDOFF_PATH);
        });

        it(`includes the four handoff-note fields for ${type}`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          expect(result.prompt).toContain("**Done:**");
          expect(result.prompt).toContain("**In progress:**");
          expect(result.prompt).toContain("**Remaining:**");
          expect(result.prompt).toContain("**Known issues:**");
        });

        it(`includes the handoff-path convention section for ${type}`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          expect(result.prompt).toContain("**Handoff path convention.**");
        });
      }

      for (const type of MUTATING_TYPES) {
        it(`includes checkpoint cadence for ${type} (mutating)`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          expect(result.prompt).toContain("**Checkpoint cadence.**");
          expect(result.prompt).toContain("wip(mt#456)");
        });
      }

      for (const type of READ_ONLY_TYPES) {
        it(`omits checkpoint cadence for ${type} (read-only)`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          expect(result.prompt).not.toContain("**Checkpoint cadence.**");
        });

        it(`omits wip(mt#...) instruction for ${type} (read-only)`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          expect(result.prompt).not.toContain("wip(mt#456)");
        });
      }
    });

    describe("omitOperatingEnvelope: true", () => {
      for (const type of ALL_TYPES) {
        it(`suppresses the envelope for ${type}`, () => {
          const result = generateSubagentPrompt({
            ...baseParams,
            type,
            omitOperatingEnvelope: true,
          });
          expect(result.prompt).not.toContain(ENVELOPE_HEADER);
          expect(result.prompt).not.toContain("**Budget awareness.**");
          expect(result.prompt).not.toContain("**Graceful exit.**");
          expect(result.prompt).not.toContain(EXPECTED_HANDOFF_PATH);
        });
      }
    });

    describe("rendered length", () => {
      function extractEnvelope(prompt: string): string {
        const start = prompt.indexOf(ENVELOPE_HEADER);
        expect(start).toBeGreaterThan(-1);
        // Envelope ends at the next `## ` heading or end of string
        const afterHeader = prompt.indexOf("\n## ", start + ENVELOPE_HEADER.length);
        return afterHeader === -1 ? prompt.slice(start) : prompt.slice(start, afterHeader);
      }

      for (const type of ALL_TYPES) {
        it(`rendered envelope for ${type} is ≤60 lines`, () => {
          const result = generateSubagentPrompt({ ...baseParams, type });
          const envelope = extractEnvelope(result.prompt);
          const lineCount = envelope.split("\n").length;
          expect(lineCount).toBeLessThanOrEqual(60);
        });
      }
    });

    describe("batched mode", () => {
      it("includes envelope in every batch by default", () => {
        const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
        const result = generateSubagentPrompt({ ...baseParams, scope });
        expect(result.batches).toBeDefined();
        for (const batch of result.batches ?? []) {
          expect(batch.prompt).toContain(ENVELOPE_HEADER);
        }
      });

      it("suppresses envelope in every batch when omitOperatingEnvelope: true", () => {
        const scope = Array.from({ length: 41 }, (_, i) => `src/file${i}.ts`);
        const result = generateSubagentPrompt({
          ...baseParams,
          scope,
          omitOperatingEnvelope: true,
        });
        expect(result.batches).toBeDefined();
        for (const batch of result.batches ?? []) {
          expect(batch.prompt).not.toContain(ENVELOPE_HEADER);
        }
      });
    });
  });
});
