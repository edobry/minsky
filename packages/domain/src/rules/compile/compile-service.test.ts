import { describe, it, expect } from "bun:test";
import { CompileService, createCompileService } from "./compile-service";
import type { CompileTarget, CompileResult, TargetOptions } from "./types";
import type { Rule } from "../types";
import type { RuleService } from "../../rules";
import { makeRule } from "./test-utils";

// Helper to create a mock RuleService
function createMockRuleService(rules: Rule[]): RuleService {
  return {
    listRules: async () => rules,
  } as unknown as RuleService;
}

// Mock target that captures calls
function createMockTarget(
  id: string
): CompileTarget & { compileCalled: boolean; lastRules: Rule[] } {
  const mockTarget = {
    id,
    displayName: `Mock ${id}`,
    compileCalled: false,
    lastRules: [] as Rule[],

    defaultOutputPath(workspacePath: string): string {
      return `${workspacePath}/mock-${id}.md`;
    },

    listOutputFiles(_rules: Rule[], options: TargetOptions, workspacePath: string): string[] {
      return [options.outputPath || `${workspacePath}/mock-${id}.md`];
    },

    async compile(
      rules: Rule[],
      options: TargetOptions,
      workspacePath: string
    ): Promise<CompileResult> {
      mockTarget.compileCalled = true;
      mockTarget.lastRules = rules;
      return {
        target: id,
        filesWritten: [`${workspacePath}/mock-${id}.md`],
        rulesIncluded: rules.map((r) => r.id),
        rulesSkipped: [],
      };
    },
  };
  return mockTarget;
}

const WORKSPACE_PATH = "/fake/workspace";

describe("CompileService", () => {
  describe("target registration", () => {
    it("registers a target and makes it available", () => {
      const service = new CompileService();
      const target = createMockTarget("test-target");
      service.registerTarget(target);

      expect(service.getAvailableTargets()).toContain("test-target");
    });

    it("getAvailableTargets returns empty array initially", () => {
      const service = new CompileService();
      expect(service.getAvailableTargets()).toHaveLength(0);
    });

    it("can register multiple targets", () => {
      const service = new CompileService();
      service.registerTarget(createMockTarget("target-a"));
      service.registerTarget(createMockTarget("target-b"));

      const available = service.getAvailableTargets();
      expect(available).toContain("target-a");
      expect(available).toContain("target-b");
      expect(available).toHaveLength(2);
    });
  });

  describe("compile", () => {
    it("throws when target is not registered", async () => {
      const service = new CompileService();
      const ruleService = createMockRuleService([]);

      await expect(
        service.compile(ruleService, "nonexistent", { workspacePath: WORKSPACE_PATH })
      ).rejects.toThrow(/Unknown compile target/);
    });

    it("delegates to the correct target", async () => {
      const service = new CompileService();
      const mockTarget = createMockTarget("test-target");
      service.registerTarget(mockTarget);

      const rules = [makeRule("rule-a", "Content A")];
      const ruleService = createMockRuleService(rules);

      await service.compile(ruleService, "test-target", { workspacePath: WORKSPACE_PATH });

      expect(mockTarget.compileCalled).toBe(true);
    });

    it("passes rules from ruleService to target", async () => {
      const service = new CompileService();
      const mockTarget = createMockTarget("test-target");
      service.registerTarget(mockTarget);

      const rules = [makeRule("rule-a", "Content A"), makeRule("rule-b", "Content B")];
      const ruleService = createMockRuleService(rules);

      await service.compile(ruleService, "test-target", { workspacePath: WORKSPACE_PATH });

      expect(mockTarget.lastRules).toHaveLength(2);
      expect(mockTarget.lastRules.map((r) => r.id)).toContain("rule-a");
      expect(mockTarget.lastRules.map((r) => r.id)).toContain("rule-b");
    });

    it("returns CompileResult from the target", async () => {
      const service = new CompileService();
      service.registerTarget(createMockTarget("test-target"));

      const rules = [makeRule("rule-a", "Content A")];
      const ruleService = createMockRuleService(rules);

      const result = await service.compile(ruleService, "test-target", {
        workspacePath: WORKSPACE_PATH,
      });

      expect(result.target).toBe("test-target");
      expect(result.rulesIncluded).toContain("rule-a");
    });

    it("dry-run returns content without calling target compile directly", async () => {
      const service = createCompileService();
      const rules = [makeRule("rule-a", "Content A", { alwaysApply: true })];
      const ruleService = createMockRuleService(rules);

      const result = await service.compile(ruleService, "agents.md", {
        workspacePath: WORKSPACE_PATH,
        dryRun: true,
      });

      // Content should be present for dry-run
      expect(result.content).toBeDefined();
      expect(result.filesWritten).toHaveLength(0);
    });
  });
});

describe("createCompileService", () => {
  it("returns a CompileService with default targets registered", () => {
    const service = createCompileService();
    const available = service.getAvailableTargets();
    expect(available).toContain("agents.md");
    expect(available).toContain("claude.md");
  });
});
