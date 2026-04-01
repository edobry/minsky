/**
 * Compile Service
 *
 * Orchestrates multi-target rule compilation. Manages registered targets and
 * delegates compilation to the appropriate target implementation.
 */

import { classifyRuleType } from "../rule-classifier";
import type { RuleService } from "../../rules";
import type { CompileTarget, CompileResult, TargetOptions } from "./types";
import { agentsMdTarget } from "./targets/agents-md";
import { claudeMdTarget } from "./targets/claude-md";

export class CompileService {
  private targets = new Map<string, CompileTarget>();

  registerTarget(target: CompileTarget): void {
    this.targets.set(target.id, target);
  }

  getAvailableTargets(): string[] {
    return Array.from(this.targets.keys());
  }

  async compile(
    ruleService: RuleService,
    targetId: string,
    options: TargetOptions & { workspacePath: string; dryRun?: boolean }
  ): Promise<CompileResult & { content?: string }> {
    const target = this.targets.get(targetId);
    if (!target) {
      throw new Error(
        `Unknown compile target: "${targetId}". Available targets: ${this.getAvailableTargets().join(", ")}`
      );
    }

    const { workspacePath, dryRun, ...targetOptions } = options;

    // List all rules
    const allRules = await ruleService.listRules({});

    // Filter by ruleTypes if specified
    let filteredRules = allRules;
    if (targetOptions.ruleTypes && targetOptions.ruleTypes.length > 0) {
      const allowedTypes = new Set(targetOptions.ruleTypes);
      filteredRules = allRules.filter((rule) => allowedTypes.has(classifyRuleType(rule)));
    }

    // Filter by tags if specified
    if (targetOptions.tags && targetOptions.tags.length > 0) {
      const requiredTags = new Set(targetOptions.tags);
      filteredRules = filteredRules.filter(
        (rule) => rule.tags && rule.tags.some((tag) => requiredTags.has(tag))
      );
    }

    // Filter out excluded tags
    if (targetOptions.excludeTags && targetOptions.excludeTags.length > 0) {
      const excludedTags = new Set(targetOptions.excludeTags);
      filteredRules = filteredRules.filter(
        (rule) => !rule.tags || !rule.tags.some((tag) => excludedTags.has(tag))
      );
    }

    if (dryRun) {
      // For dry-run, compute content without writing files
      // We use a temporary approach: intercept the compile call
      const result = await compileDryRun(target, filteredRules, targetOptions, workspacePath);
      return result;
    }

    return await target.compile(filteredRules, targetOptions, workspacePath);
  }
}

/**
 * Perform dry-run compilation by computing content without writing files.
 * Delegates to target-specific content builders to avoid writing to disk.
 */
async function compileDryRun(
  target: CompileTarget,
  rules: any[],
  options: TargetOptions,
  workspacePath: string
): Promise<CompileResult & { content: string }> {
  if (target.id === "agents.md") {
    const { buildContent, DEFAULT_AGENTS_MD_SECTIONS } = await import("./targets/agents-md");
    const { content, rulesIncluded, rulesSkipped } = buildContent(
      rules,
      DEFAULT_AGENTS_MD_SECTIONS
    );
    return {
      target: target.id,
      filesWritten: [],
      rulesIncluded,
      rulesSkipped,
      content,
    };
  }

  if (target.id === "claude.md") {
    const { buildClaudeMdContent } = await import("./targets/claude-md");
    const { content, rulesIncluded, rulesSkipped } = buildClaudeMdContent(rules);
    return {
      target: target.id,
      filesWritten: [],
      rulesIncluded,
      rulesSkipped,
      content,
    };
  }

  // For unknown targets, fallback: actually compile and return result without content
  const result = await target.compile(rules, options, workspacePath);
  return { ...result, content: undefined as any };
}

/**
 * Factory function that creates a CompileService with the default targets registered
 */
export function createCompileService(): CompileService {
  const service = new CompileService();
  service.registerTarget(agentsMdTarget);
  service.registerTarget(claudeMdTarget);
  return service;
}
