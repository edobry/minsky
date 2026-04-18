import { describe, it, expect } from "bun:test";
import {
  generateSubagentPrompt,
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
      expect(result.suggestedSubagentType).toBeUndefined();
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

    it("suggests refactor subagent type", () => {
      const result = generateSubagentPrompt({ ...baseParams, type: "refactor" });
      expect(result.suggestedSubagentType).toBe("refactor");
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
      expect(result.suggestedSubagentType).toBeUndefined();
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
      expect(result.suggestedSubagentType).toBeUndefined();
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
});
