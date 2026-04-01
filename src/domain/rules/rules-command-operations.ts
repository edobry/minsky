/**
 * Rules Command Operations
 *
 * Domain logic extracted from the adapter-layer rules command handlers.
 * These functions contain the actual business logic that was previously
 * inlined in execute() callbacks.
 */
import fs from "fs/promises";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { RuleService, type RuleFormat } from "../rules";
import { resolveActiveRules } from "./rule-selection";
import { RULE_PRESETS } from "../configuration/schemas/rules";
import { createRuleTemplateService } from "./rule-template-service";
import { type RuleGenerationConfig } from "./template-system";
import { readContentFromFileIfExists, parseGlobs } from "../../utils/rules-helpers";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RulesSelectionConfig {
  presets: string[];
  enabled: string[];
  disabled: string[];
}

export interface MigrateRulesOptions {
  workspacePath: string;
  dryRun: boolean;
  force: boolean;
}

export interface MigrateRulesResult {
  success: boolean;
  error?: string;
  dryRun?: boolean;
  migrated?: string[];
  skipped?: string[];
  sourceDir?: string;
  destDir?: string;
  nextSteps?: string[];
}

export interface IndexEmbeddingsOptions {
  workspacePath: string;
  limit?: number;
  force?: boolean;
  json?: boolean;
  debug?: boolean;
}

export interface IndexEmbeddingsResult {
  success: boolean;
  indexed?: number;
  skipped?: number;
  total?: number;
  ms?: number;
  error?: string;
}

export interface EnhancedRuleSearchResult {
  id: string;
  score: number;
  name: string;
  description: string;
  format: string;
}

export interface SearchRulesEnhancedOptions {
  workspacePath: string;
  query?: string;
  limit?: number;
  threshold?: number;
}

export interface RulesConfigResult {
  success: boolean;
  presets: string[];
  enabled: string[];
  disabled: string[];
  activeRuleCount: number;
  totalRuleCount: number;
}

export interface RulesPresetsResult {
  success: boolean;
  presets: Array<{ name: string; ruleCount: number; rules: string[] }>;
}

// ─── Rules Selection Config ──────────────────────────────────────────────────

/**
 * Read the rules selection config (presets/enabled/disabled) from the project
 * config file (.minsky/config.yaml). Returns defaults if file doesn't exist.
 */
export async function readRulesSelectionConfig(
  workspacePath: string
): Promise<RulesSelectionConfig> {
  const configPath = join(workspacePath, ".minsky", "config.yaml");
  let raw: any = {};

  try {
    const content = String(await fs.readFile(configPath, "utf8"));
    raw = parseYaml(content) || {};
  } catch {
    // File doesn't exist or is unreadable — start from empty config
  }

  const rules = raw?.rules || {};
  return {
    presets: Array.isArray(rules.presets) ? rules.presets : [],
    enabled: Array.isArray(rules.enabled) ? rules.enabled : [],
    disabled: Array.isArray(rules.disabled) ? rules.disabled : [],
  };
}

/**
 * Write the rules selection config back to the project config file.
 */
export async function writeRulesSelectionConfig(
  workspacePath: string,
  config: RulesSelectionConfig
): Promise<void> {
  const minskyDir = join(workspacePath, ".minsky");
  const configPath = join(minskyDir, "config.yaml");

  let raw: any = {};
  try {
    const content = String(await fs.readFile(configPath, "utf8"));
    raw = parseYaml(content) || {};
  } catch {
    // File doesn't exist — create fresh
  }

  if (!raw.rules) raw.rules = {};
  raw.rules.presets = config.presets;
  raw.rules.enabled = config.enabled;
  raw.rules.disabled = config.disabled;

  // Ensure directory exists
  try {
    await fs.mkdir(minskyDir, { recursive: true });
  } catch {
    // Already exists
  }

  await fs.writeFile(configPath, stringifyYaml(raw, { indent: 2 }), "utf8");
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

/**
 * Enable a rule by adding it to the enabled list and removing from disabled.
 */
export async function enableRule(
  workspacePath: string,
  ruleId: string
): Promise<{ enabled: string[]; disabled: string[] }> {
  const config = await readRulesSelectionConfig(workspacePath);

  if (!config.enabled.includes(ruleId)) {
    config.enabled.push(ruleId);
  }
  // Remove from disabled if present
  config.disabled = config.disabled.filter((id) => id !== ruleId);

  await writeRulesSelectionConfig(workspacePath, config);
  return { enabled: config.enabled, disabled: config.disabled };
}

/**
 * Disable a rule by adding it to the disabled list and removing from enabled.
 */
export async function disableRule(
  workspacePath: string,
  ruleId: string
): Promise<{ enabled: string[]; disabled: string[] }> {
  const config = await readRulesSelectionConfig(workspacePath);

  if (!config.disabled.includes(ruleId)) {
    config.disabled.push(ruleId);
  }
  // Remove from enabled if present
  config.enabled = config.enabled.filter((id) => id !== ruleId);

  await writeRulesSelectionConfig(workspacePath, config);
  return { enabled: config.enabled, disabled: config.disabled };
}

// ─── Config / Presets ────────────────────────────────────────────────────────

/**
 * Get the current rules configuration state including active rule count.
 */
export async function getRulesConfig(workspacePath: string): Promise<RulesConfigResult> {
  const config = await readRulesSelectionConfig(workspacePath);

  const ruleService = new RuleService(workspacePath);
  const allRules = await ruleService.listRules({});
  const allRuleIds = allRules.map((r) => r.id);
  const activeIds = resolveActiveRules(allRuleIds, config);

  return {
    success: true,
    presets: config.presets,
    enabled: config.enabled,
    disabled: config.disabled,
    activeRuleCount: activeIds.size,
    totalRuleCount: allRuleIds.length,
  };
}

/**
 * List available rule presets with their rule counts.
 */
export function getRulesPresets(): RulesPresetsResult {
  const presets = Object.entries(RULE_PRESETS).map(([name, ruleIds]) => ({
    name,
    ruleCount: ruleIds.length,
    rules: ruleIds,
  }));
  return { success: true, presets };
}

// ─── Migration ───────────────────────────────────────────────────────────────

/**
 * Migrate rules from .cursor/rules/ to .minsky/rules/.
 */
export async function migrateRules(options: MigrateRulesOptions): Promise<MigrateRulesResult> {
  const { workspacePath, dryRun, force } = options;
  const sourceDir = join(workspacePath, ".cursor/rules");
  const destDir = join(workspacePath, ".minsky/rules");

  // Check if source directory exists
  let sourceEntries: string[];
  try {
    const entries = await fs.readdir(sourceDir);
    sourceEntries = entries.filter((f) => f.endsWith(".mdc"));
  } catch {
    return {
      success: false,
      error: `Source directory does not exist: ${sourceDir}`,
    };
  }

  if (sourceEntries.length === 0) {
    return {
      success: false,
      error: `No .mdc files found in source directory: ${sourceDir}`,
    };
  }

  // Create dest dir if needed (unless dry run)
  if (!dryRun) {
    await fs.mkdir(destDir, { recursive: true });
  }

  const migrated: string[] = [];
  const skipped: string[] = [];

  for (const filename of sourceEntries) {
    const srcFile = join(sourceDir, filename);
    const destFile = join(destDir, filename);

    // Check if destination file already exists
    let destExists = false;
    try {
      await fs.access(destFile);
      destExists = true;
    } catch {
      destExists = false;
    }

    if (destExists && !force) {
      skipped.push(filename);
      continue;
    }

    if (!dryRun) {
      const content = await fs.readFile(srcFile);
      await fs.writeFile(destFile, content);
    }
    migrated.push(filename);
  }

  return {
    success: true,
    dryRun,
    migrated,
    skipped,
    sourceDir,
    destDir,
    nextSteps: [
      "Run `minsky rules compile --target cursor-rules` to regenerate " +
        ".cursor/rules/ from the new canonical source",
      "Add `.cursor/rules/` to your .gitignore",
      "Run `git rm -r --cached .cursor/rules/` to untrack the old files",
    ],
  };
}

// ─── Index Embeddings ────────────────────────────────────────────────────────

/**
 * Index embeddings for rules using the similarity service.
 */
export async function indexRuleEmbeddings(
  options: IndexEmbeddingsOptions
): Promise<IndexEmbeddingsResult> {
  const { createRuleSimilarityService } = await import("./rule-similarity-service");
  const service = await createRuleSimilarityService();

  const ruleService = new RuleService(options.workspacePath);
  const rules = await ruleService.listRules({});

  // Apply limit for debugging
  const slice = options.limit ? rules.slice(0, options.limit) : rules;

  if (slice.length === 0) {
    return { success: true, indexed: 0, skipped: 0, total: 0 };
  }

  let indexed = 0;
  let skipped = 0;
  const start = Date.now();

  if (!options.json) {
    log.cli(`Indexing embeddings for ${slice.length} rule(s)...`);
  }

  for (const rule of slice) {
    if (!options.json) {
      log.cli(`- ${rule.id}`);
    }

    try {
      const changed = await service.indexRule(rule.id);
      if (changed) {
        indexed++;
      } else {
        skipped++;
      }
    } catch (error) {
      skipped++;
      if (options.debug) {
        log.cliError(`Error indexing rule ${rule.id}: ${getErrorMessage(error as any)}`);
      }
    }
  }

  const elapsed = Date.now() - start;
  return { success: true, indexed, skipped, total: slice.length, ms: elapsed };
}

// ─── Enhanced Search ─────────────────────────────────────────────────────────

/**
 * Perform similarity search and enhance results with full rule details.
 */
export interface ListRulesOptions {
  workspacePath: string;
  format?: RuleFormat;
  tag?: string;
  since?: string;
  until?: string;
  debug?: boolean;
}

export interface ListRulesResult {
  success: boolean;
  rules: Array<Record<string, unknown>>;
}

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
  let filtered = rules;
  try {
    const { parseTime, filterByTimeRange } = await import("../../utils/result-handling/filters");
    const sinceTs = parseTime(options.since);
    const untilTs = parseTime(options.until);
    if (sinceTs !== null || untilTs !== null) {
      const withUpdatedAt = await Promise.all(
        rules.map(async (rule) => {
          try {
            const stat = await fs.stat(rule.path);
            return { ...rule, updatedAt: new Date(stat.mtimeMs) } as any;
          } catch {
            return { ...rule } as any;
          }
        })
      );
      filtered = filterByTimeRange(withUpdatedAt as any[], sinceTs, untilTs) as any[];
    }
  } catch {
    // ignore filtering errors
  }

  // Transform rules to exclude content field for better usability
  const rulesWithoutContent = filtered.map(({ content, ...rule }) => rule);

  return { success: true, rules: rulesWithoutContent };
}

export interface CompileRulesOptions {
  workspacePath: string;
  target?: string;
  output?: string;
  dryRun?: boolean;
  check?: boolean;
}

export interface CompileRulesResult {
  success: boolean;
  check?: boolean;
  stale?: boolean;
  dryRun?: boolean;
  content?: string;
  filesWritten?: string[];
  rulesIncluded?: string[];
  rulesSkipped?: string[];
}

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

// ─── Get Rule ────────────────────────────────────────────────────────────────

export interface GetRuleOptions {
  workspacePath: string;
  id: string;
  format?: RuleFormat;
  debug?: boolean;
}

export interface GetRuleResult {
  success: boolean;
  rule: Record<string, unknown>;
}

/**
 * Get a specific rule by ID.
 */
export async function getRule(options: GetRuleOptions): Promise<GetRuleResult> {
  const ruleService = new RuleService(options.workspacePath);
  const rule = await ruleService.getRule(options.id, {
    format: options.format,
    debug: options.debug,
  });
  return { success: true, rule: rule as unknown as Record<string, unknown> };
}

// ─── Generate Rules ──────────────────────────────────────────────────────────

export interface GenerateRulesOptions {
  workspacePath: string;
  interface?: "cli" | "mcp" | "hybrid";
  rules?: string;
  outputDir?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  format?: RuleFormat;
  preferMcp?: boolean;
  mcpTransport?: "stdio" | "http";
}

export interface GenerateRulesResult {
  success: boolean;
  rules: unknown[];
  errors: unknown[];
  generated: number;
}

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

// ─── Create Rule ─────────────────────────────────────────────────────────────

export interface CreateRuleOptions {
  workspacePath: string;
  id: string;
  content: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: RuleFormat;
  overwrite?: boolean;
}

export interface CreateRuleResult {
  success: boolean;
  rule: Record<string, unknown>;
}

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

  return { success: true, rule: rule as unknown as Record<string, unknown> };
}

// ─── Update Rule ─────────────────────────────────────────────────────────────

export interface UpdateRuleOptions {
  workspacePath: string;
  id: string;
  content?: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: RuleFormat;
  debug?: boolean;
}

export interface UpdateRuleResult {
  success: boolean;
  rule: Record<string, unknown>;
}

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

  return { success: true, rule: rule as unknown as Record<string, unknown> };
}

export async function searchRulesEnhanced(
  options: SearchRulesEnhancedOptions
): Promise<EnhancedRuleSearchResult[]> {
  const { createRuleSimilarityService } = await import("./rule-similarity-service");
  const service = await createRuleSimilarityService();

  const { query, limit = 10, threshold } = options;

  if (!query) {
    return [];
  }

  const results = await service.searchByText(query, limit, threshold);

  const { ModularRulesService } = await import("./rules-service-modular");
  const rulesService = new ModularRulesService(options.workspacePath);

  const enhancedResults: EnhancedRuleSearchResult[] = [];
  for (const result of results) {
    try {
      const rule = await rulesService.getRule(result.id);
      enhancedResults.push({
        id: result.id,
        score: result.score,
        name: rule.name || result.id,
        description: rule.description || rule.name || "",
        format: rule.format || "",
      });
    } catch {
      enhancedResults.push({
        id: result.id,
        score: result.score,
        name: result.id,
        description: "",
        format: "",
      });
    }
  }

  return enhancedResults;
}
