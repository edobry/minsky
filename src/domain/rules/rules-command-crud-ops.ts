/**
 * Rules Command CRUD Operations
 *
 * Operations for listing, getting, creating, updating, compiling,
 * and generating rules.
 */
import fs from "fs/promises";
import { RuleService, type RuleFormat } from "../rules";
import { createRuleTemplateService } from "./rule-template-service";
import { type RuleGenerationConfig } from "./template-system";
import { readContentFromFileIfExists, parseGlobs } from "../../utils/rules-helpers";
import type {
  ListRulesOptions,
  ListRulesResult,
  CompileRulesOptions,
  CompileRulesResult,
  GetRuleOptions,
  GetRuleResult,
  GenerateRulesOptions,
  GenerateRulesResult,
  CreateRuleOptions,
  CreateRuleResult,
  UpdateRuleOptions,
  UpdateRuleResult,
} from "./rules-command-types";

// ─── List Rules ───────────────────────────────────────────────────────────────

/**
 * List rules with optional time-range filtering.
 * Time filtering uses file modification time as a proxy for updatedAt.
 */
export async function listRulesFiltered(options: ListRulesOptions): Promise<ListRulesResult> {
  const ruleService = new RuleService(options.workspacePath);

  const rules = await ruleService.listRules({
    format: options.format,
    tag: options.tag,
    debug: options.debug,
  });

  // Optional time filtering using file modification time as proxy
  type RuleWithUpdatedAt = (typeof rules)[0] & { updatedAt?: Date };
  let filtered: RuleWithUpdatedAt[] = rules;
  try {
    const { parseTime, filterByTimeRange } = await import("../../utils/result-handling/filters");
    const sinceTs = parseTime(options.since);
    const untilTs = parseTime(options.until);
    if (sinceTs !== null || untilTs !== null) {
      const withUpdatedAt = await Promise.all(
        rules.map(async (rule): Promise<RuleWithUpdatedAt> => {
          try {
            const stat = await fs.stat(rule.path);
            return { ...rule, updatedAt: new Date(stat.mtimeMs) };
          } catch {
            return { ...rule };
          }
        })
      );
      filtered = filterByTimeRange(withUpdatedAt, sinceTs, untilTs);
    }
  } catch {
    // ignore filtering errors
  }

  // Transform rules to exclude content field for better usability
  const rulesWithoutContent = filtered.map(({ content, ...rule }) => rule);

  return { success: true, rules: rulesWithoutContent };
}

// ─── Compile Rules ────────────────────────────────────────────────────────────

/**
 * Compile rules into a monolithic file, with optional check (staleness) mode.
 */
export async function compileRules(options: CompileRulesOptions): Promise<CompileRulesResult> {
  const { createCompileService, agentsMdTarget, claudeMdTarget } = await import("./compile");

  const targetId = options.target || "agents.md";
  const ruleService = new RuleService(options.workspacePath);
  const compileService = createCompileService();

  // For check mode, do a dry-run first to get the compiled content
  if (options.check) {
    const dryResult = await compileService.compile(ruleService, targetId, {
      workspacePath: options.workspacePath,
      outputPath: options.output,
      dryRun: true,
    });

    // Determine the output path for the target
    const targetMap: Record<string, { defaultOutputPath(w: string): string }> = {
      "agents.md": agentsMdTarget,
      "claude.md": claudeMdTarget,
    };
    const targetObj = targetMap[targetId];
    const outputFilePath =
      options.output ||
      (targetObj
        ? targetObj.defaultOutputPath(options.workspacePath)
        : `${options.workspacePath}/OUT.md`);

    try {
      const existingContent = await fs.readFile(outputFilePath, "utf-8");
      const isStale = existingContent !== dryResult.content;
      return {
        success: true,
        check: true,
        stale: isStale,
        rulesIncluded: dryResult.rulesIncluded,
        rulesSkipped: dryResult.rulesSkipped,
      };
    } catch {
      // File doesn't exist — it's stale
      return {
        success: true,
        check: true,
        stale: true,
        rulesIncluded: dryResult.rulesIncluded,
        rulesSkipped: dryResult.rulesSkipped,
      };
    }
  }

  const result = await compileService.compile(ruleService, targetId, {
    workspacePath: options.workspacePath,
    outputPath: options.output,
    dryRun: options.dryRun || false,
  });

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      content: result.content,
      filesWritten: result.filesWritten,
      rulesIncluded: result.rulesIncluded,
      rulesSkipped: result.rulesSkipped,
    };
  }

  return {
    success: true,
    dryRun: false,
    filesWritten: result.filesWritten,
    rulesIncluded: result.rulesIncluded,
    rulesSkipped: result.rulesSkipped,
  };
}

// ─── Get Rule ─────────────────────────────────────────────────────────────────

/**
 * Get a specific rule by ID.
 */
export async function getRule(options: GetRuleOptions): Promise<GetRuleResult> {
  const ruleService = new RuleService(options.workspacePath);
  const rule = await ruleService.getRule(options.id, {
    format: options.format,
    debug: options.debug,
  });
  return { success: true, rule };
}

// ─── Generate Rules ───────────────────────────────────────────────────────────

/**
 * Generate rules from templates.
 */
export async function generateRules(options: GenerateRulesOptions): Promise<GenerateRulesResult> {
  const ruleTemplateService = createRuleTemplateService(options.workspacePath);
  await ruleTemplateService.registerDefaultTemplates();

  const config: RuleGenerationConfig = {
    interface: (options.interface || "cli") as "cli" | "mcp" | "hybrid",
    mcpEnabled: options.interface === "mcp" || options.interface === "hybrid",
    mcpTransport: (options.mcpTransport || "stdio") as "stdio" | "http",
    preferMcp: options.preferMcp || false,
    ruleFormat: (options.format || "cursor") as RuleFormat,
    outputDir: options.outputDir || (options.format === "cursor" ? ".cursor/rules" : ".ai/rules"),
  };

  const selectedRules = options.rules ? options.rules.split(",").map((t) => t.trim()) : undefined;
  const dryRun = options.dryRun || false;
  const overwrite = options.overwrite || false;

  const result = await ruleTemplateService.generateRules({
    config,
    selectedRules,
    dryRun,
    overwrite,
  });
  return {
    success: result.success,
    rules: result.rules,
    errors: result.errors,
    generated: result.rules.length,
  };
}

// ─── Create Rule ──────────────────────────────────────────────────────────────

/**
 * Create a new rule.
 */
export async function createRule(options: CreateRuleOptions): Promise<CreateRuleResult> {
  const ruleService = new RuleService(options.workspacePath);
  const content = await readContentFromFileIfExists(options.content);
  const globs = parseGlobs(options.globs);
  const tags = options.tags ? options.tags.split(",").map((tag: string) => tag.trim()) : undefined;

  const meta = {
    name: options.name || options.id,
    description: options.description,
    globs,
    tags,
  };

  const rule = await ruleService.createRule(options.id, content, meta, {
    format: options.format,
    overwrite: options.overwrite,
  });

  return { success: true, rule };
}

// ─── Update Rule ──────────────────────────────────────────────────────────────

/**
 * Update an existing rule.
 */
export async function updateRule(options: UpdateRuleOptions): Promise<UpdateRuleResult> {
  const ruleService = new RuleService(options.workspacePath);
  const content = options.content ? await readContentFromFileIfExists(options.content) : undefined;
  const globs = options.globs ? parseGlobs(options.globs) : undefined;
  const tags = options.tags ? options.tags.split(",").map((tag: string) => tag.trim()) : undefined;

  const meta: Record<string, unknown> = {};
  if (options.name !== undefined) meta.name = options.name;
  if (options.description !== undefined) meta.description = options.description;
  if (globs !== undefined) meta.globs = globs;
  if (tags !== undefined) meta.tags = tags;

  const rule = await ruleService.updateRule(
    options.id,
    {
      content,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    },
    { format: options.format, debug: options.debug }
  );

  return { success: true, rule };
}
