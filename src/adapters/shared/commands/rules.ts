/**
 * Shared Rules Commands
 *
 * This module contains shared rules command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
import { RuleService, type RuleFormat } from "../../../domain/rules";
import { createRuleTemplateService } from "../../../domain/rules/rule-template-service";
import { type RuleGenerationConfig } from "../../../domain/rules/template-system";
import { resolveWorkspacePath } from "../../../domain/workspace";
import type { EnhancedSearchResult } from "./similarity-command-factory";

/**
 * Rule-style result formatter for similarity search results
 * Format: "1. rule-name [cursor] - Description of the rule"
 */
function ruleStyleFormatter(
  result: EnhancedSearchResult,
  index: number,
  showScore: boolean
): string {
  const name = result.name || result.id;
  const format = (result as any).format;
  const formatPart = format ? ` [${format}]` : "";
  const desc = result.description ? ` - ${result.description}` : "";
  const scorePart =
    showScore && result.score !== undefined ? `\nScore: ${result.score.toFixed(3)}` : "";
  return `${index + 1}. ${name}${formatPart}${desc}${scorePart}`;
}
import { readContentFromFileIfExists, parseGlobs } from "../../../utils/rules-helpers";
import { log } from "../../../utils/logger";
import {
  RULE_FORMAT_DESCRIPTION,
  RULE_TAGS_DESCRIPTION,
  RULE_CONTENT_DESCRIPTION,
  RULE_DESCRIPTION_DESCRIPTION,
  RULE_NAME_DESCRIPTION,
  OVERWRITE_DESCRIPTION,
} from "../../../utils/option-descriptions";
import { CommonParameters, RulesParameters, composeParams } from "../common-parameters";
import { getConfiguration } from "../../../domain/configuration";
import fs from "fs/promises";
import fsSync from "fs";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { RULE_PRESETS } from "../../../domain/configuration/schemas/rules";
import { resolveActiveRules } from "../../../domain/rules/rule-selection";
import { getEmbeddingDimension } from "../../../domain/ai/embedding-models";
import { createEmbeddingServiceFromConfig } from "../../../domain/ai/embedding-service-factory";
import { PostgresVectorStorage } from "../../../domain/storage/vector/postgres-vector-storage";

/**
 * Parameters for the rules list command
 */
type RulesListParams = {
  format?: "cursor" | "generic";
  tag?: string;
  json?: boolean;
  debug?: boolean;
};

const rulesListCommandParams: CommandParameterMap = composeParams(
  {
    format: RulesParameters.format,
    tag: RulesParameters.tag,
    since: {
      schema: z.string().optional(),
      description:
        "Optional: filter by updated time (YYYY-MM-DD or 7d/24h/30m). Currently not enforced due to missing timestamps.",
      required: false,
    },
    until: {
      schema: z.string().optional(),
      description:
        "Optional: filter by updated time (YYYY-MM-DD or 7d/24h/30m). Currently not enforced due to missing timestamps.",
      required: false,
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Parameters for the rules index-embeddings command
 */
type RulesIndexEmbeddingsParams = {
  limit?: number;
  json?: boolean;
  debug?: boolean;
  force?: boolean;
};

const rulesIndexEmbeddingsParams: CommandParameterMap = composeParams(
  {
    limit: {
      schema: z.number().int().positive().optional(),
      description: "Limit number of rules to index (for debugging)",
      required: false,
    },
    force: {
      schema: z.boolean(),
      description: "Force reindex even if content hash matches",
      required: false,
      defaultValue: false,
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Parameters for the rules get command
 */
type RulesGetParams = {
  id: string;
  format?: "cursor" | "generic";
  json?: boolean;
  debug?: boolean;
};

const rulesGetCommandParams: CommandParameterMap = composeParams(
  {
    id: RulesParameters.id,
    format: RulesParameters.format,
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Parameters for the rules generate command
 */
type RulesGenerateParams = {
  interface?: "cli" | "mcp" | "hybrid";
  rules?: string;
  outputDir?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  format?: RuleFormat;
  preferMcp?: boolean;
  mcpTransport?: "stdio" | "http";
  json?: boolean;
  debug?: boolean;
};

const rulesGenerateCommandParams: CommandParameterMap = {
  interface: {
    schema: z.enum(["cli", "mcp", "hybrid"]),
    description: "Interface preference for generated rules (cli, mcp, or hybrid)",
    required: false,
    defaultValue: "cli",
  },
  rules: {
    schema: z.string().optional(),
    description:
      "Comma-separated list of specific rule templates to generate (if not specified, generates all available templates)",
    required: false,
  },
  outputDir: {
    schema: z.string().optional(),
    description:
      "Output directory for generated rules (defaults to .cursor/rules for cursor format, .ai/rules for openai format)",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Show what would be generated without actually creating files",
    required: false,
    defaultValue: false,
  },
  overwrite: {
    schema: z.boolean(),
    description: OVERWRITE_DESCRIPTION,
    required: false,
    defaultValue: false,
  },
  format: {
    schema: z.enum(["cursor", "generic"]),
    description: "Rule format for file system organization (cursor or generic)",
    required: false,
    defaultValue: "cursor",
  },
  preferMcp: {
    schema: z.boolean(),
    description: "In hybrid mode, prefer MCP commands over CLI commands",
    required: false,
    defaultValue: false,
  },
  mcpTransport: {
    schema: z.enum(["stdio", "http"]),
    description: "MCP transport method (only relevant when interface is mcp or hybrid)",
    required: false,
    defaultValue: "stdio",
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the rules create command
 */
type RulesCreateParams = {
  id: string;
  content: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: "cursor" | "generic";
  overwrite?: boolean;
  json?: boolean;
};

const rulesCreateCommandParams: CommandParameterMap = composeParams(
  {
    id: RulesParameters.id,
    content: RulesParameters.content,
    description: {
      schema: z.string().optional(),
      description: RULE_DESCRIPTION_DESCRIPTION,
      required: false,
    },
    name: {
      schema: z.string().optional(),
      description: RULE_NAME_DESCRIPTION,
      required: false,
    },
    globs: RulesParameters.globs,
    tags: RulesParameters.tags,
    format: RulesParameters.format,
  },
  {
    overwrite: CommonParameters.overwrite,
    json: CommonParameters.json,
  }
);

/**
 * Parameters for the rules update command
 */
type RulesUpdateParams = {
  id: string;
  content?: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: "cursor" | "generic";
  json?: boolean;
  debug?: boolean;
};

const rulesUpdateCommandParams: CommandParameterMap = composeParams(
  {
    id: RulesParameters.id,
    content: {
      schema: z.string().optional(),
      description: RULE_CONTENT_DESCRIPTION,
      required: false,
    },
    description: {
      schema: z.string().optional(),
      description: RULE_DESCRIPTION_DESCRIPTION,
      required: false,
    },
    name: {
      schema: z.string().optional(),
      description: RULE_NAME_DESCRIPTION,
      required: false,
    },
    globs: RulesParameters.globs,
    tags: RulesParameters.tags,
    format: RulesParameters.format,
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Parameters for the rules search command
 */
type RulesSearchParams = {
  query?: string;
  tag?: string;
  format?: "cursor" | "generic";
  limit?: number;
  threshold?: number;
  details?: boolean;
  json?: boolean;
  debug?: boolean;
};

const rulesSearchCommandParams: CommandParameterMap = composeParams(
  {
    query: RulesParameters.query,
    format: RulesParameters.format,
    tag: RulesParameters.tag,
    limit: {
      schema: z.number().int().positive().default(10),
      help: "Max number of results",
      required: false,
    },
    threshold: {
      schema: z.number().optional(),
      help: "Optional distance threshold (lower is closer)",
      required: false,
    },
    details: {
      schema: z.boolean().default(false),
      help: "Show detailed output including scores and diagnostics",
      required: false,
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Register the rules commands in the shared command registry
 */
export function registerRulesCommands(registry?: typeof sharedCommandRegistry): void {
  const targetRegistry = registry || sharedCommandRegistry;
  // Register rules index-embeddings command
  targetRegistry.registerCommand({
    id: "rules.index-embeddings",
    category: CommandCategory.RULES,
    name: "index-embeddings",
    description: "Generate and store embeddings for rules (rules_embeddings)",
    parameters: rulesIndexEmbeddingsParams,
    execute: async (params: RulesIndexEmbeddingsParams, ctx?: CommandExecutionContext) => {
      try {
        // Use the proper service abstraction (same pattern as tasks)
        const { createRuleSimilarityService } = await import(
          "../../../domain/rules/rule-similarity-service"
        );
        const service = await createRuleSimilarityService();

        // Get list of rules to index
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);
        const rules = await ruleService.listRules({});

        // Apply limit for debugging
        const slice = params.limit ? rules.slice(0, params.limit) : rules;

        if (slice.length === 0) {
          if (params.json || ctx?.format === "json") {
            return { success: true, indexed: 0, skipped: 0, total: 0 };
          }
          log.cli("No rules found to index.");
          return { success: true };
        }

        let indexed = 0;
        let skipped = 0;
        const start = Date.now();

        if (!(params.json || ctx?.format === "json")) {
          log.cli(`Indexing embeddings for ${slice.length} rule(s)...`);
        }

        // Index each rule using the service
        for (const rule of slice) {
          if (!(params.json || ctx?.format === "json")) {
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
            if (params.debug) {
              log.cliError(`Error indexing rule ${rule.id}: ${getErrorMessage(error as any)}`);
            }
          }
        }

        const elapsed = Date.now() - start;

        if (params.json || ctx?.format === "json") {
          return {
            success: true,
            indexed,
            skipped,
            total: slice.length,
            ms: elapsed,
          };
        }

        log.cli(
          `✅ Indexed ${indexed}/${slice.length} rule(s) in ${elapsed}ms (skipped errors: ${skipped})`
        );
        return { success: true };
      } catch (error) {
        const message = getErrorMessage(error as any);
        if (params.json || ctx?.format === "json") {
          return { success: false, error: message };
        }
        log.cliError(`Failed to index rule embeddings: ${message}`);
        throw error;
      }
    },
  });
  // Register rules list command
  targetRegistry.registerCommand({
    id: "rules.list",
    category: CommandCategory.RULES,
    name: "list",
    description: "List all rules in the workspace",
    parameters: rulesListCommandParams,
    execute: async (params: RulesListParams) => {
      log.debug("Executing rules.list command", { params });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert parameters
        const format = params.format as RuleFormat | undefined;

        // Call domain function
        const rules = await ruleService.listRules({
          format,
          tag: params.tag,
          debug: params.debug,
        });

        // Optional time filtering using file modification time as proxy
        let filtered = rules;
        try {
          const { parseTime, filterByTimeRange } = await import(
            "../../../utils/result-handling/filters"
          );
          const sinceTs = parseTime((params as any).since);
          const untilTs = parseTime((params as any).until);
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

        return {
          success: true,
          rules: rulesWithoutContent,
        };
      } catch (error) {
        log.error("Failed to list rules", {
          error: getErrorMessage(error),
        });
        throw error;
      }
    },
  });

  // Register rules get command
  targetRegistry.registerCommand({
    id: "rules.get",
    category: CommandCategory.RULES,
    name: "get",
    description: "Get a specific rule by ID",
    parameters: rulesGetCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.get command", { params });

      const typedParams = params as RulesGetParams;

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert parameters
        const format = typedParams.format as RuleFormat | undefined;

        // Call domain function
        const rule = await ruleService.getRule(typedParams.id, {
          format,
          debug: typedParams.debug,
        });

        return {
          success: true,
          rule,
        };
      } catch (error) {
        log.error("Failed to get rule", {
          error: getErrorMessage(error),
          id: typedParams.id,
        });
        throw error;
      }
    },
  });

  // Register rules generate command
  targetRegistry.registerCommand({
    id: "rules.generate",
    category: CommandCategory.RULES,
    name: "generate",
    description: "Generate new rules from templates",
    parameters: rulesGenerateCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.generate command", { params });

      const typedParams = params as RulesGenerateParams;

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleTemplateService = createRuleTemplateService(workspacePath);

        // Register templates
        await ruleTemplateService.registerDefaultTemplates();

        // Convert parameters to RuleGenerationConfig
        const config: RuleGenerationConfig = {
          interface: (typedParams.interface || "cli") as "cli" | "mcp" | "hybrid",
          mcpEnabled: typedParams.interface === "mcp" || typedParams.interface === "hybrid",
          mcpTransport: (typedParams.mcpTransport || "stdio") as "stdio" | "http",
          preferMcp: typedParams.preferMcp || false,
          ruleFormat: (typedParams.format || "cursor") as RuleFormat,
          outputDir:
            typedParams.outputDir ||
            (typedParams.format === "cursor" ? ".cursor/rules" : ".ai/rules"),
        };

        const selectedRules = typedParams.rules
          ? typedParams.rules.split(",").map((t) => t.trim())
          : undefined;
        const dryRun = typedParams.dryRun || false;
        const overwrite = typedParams.overwrite || false;

        // Call domain function
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
      } catch (error) {
        log.error("Failed to generate rules", {
          error: getErrorMessage(error),
          interface: typedParams.interface,
          selectedRules: typedParams.rules,
          dryRun: typedParams.dryRun,
          overwrite: typedParams.overwrite,
        });
        throw error;
      }
    },
  });

  // Register rules create command
  targetRegistry.registerCommand({
    id: "rules.create",
    category: CommandCategory.RULES,
    name: "create",
    description: "Create a new rule",
    parameters: rulesCreateCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.create command", { params });

      const typedParams = params as RulesCreateParams;

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Process content (could be file path)
        const content = await readContentFromFileIfExists(typedParams.content);

        // Process globs and tags
        const globs = parseGlobs(typedParams.globs);
        const tags = typedParams.tags
          ? typedParams.tags.split(",").map((tag: string) => tag.trim())
          : undefined;

        // Prepare metadata
        const meta = {
          name: typedParams.name || typedParams.id,
          description: typedParams.description,
          globs,
          tags,
        };

        // Convert format
        const format = typedParams.format as RuleFormat | undefined;

        // Call domain function
        const rule = await ruleService.createRule(typedParams.id, content, meta, {
          format,
          overwrite: typedParams.overwrite,
        });

        return {
          success: true,
          rule,
        };
      } catch (error) {
        log.error("Failed to create rule", {
          error: getErrorMessage(error),
          id: typedParams.id,
        });
        throw error;
      }
    },
  });

  // Register rules update command
  targetRegistry.registerCommand({
    id: "rules.update",
    category: CommandCategory.RULES,
    name: "update",
    description: "Update an existing rule",
    parameters: rulesUpdateCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.update command", { params });

      const typedParams = params as RulesUpdateParams;

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Process content if provided (could be file path)
        const content = typedParams.content
          ? await readContentFromFileIfExists(typedParams.content)
          : undefined;

        // Process globs and tags
        const globs = typedParams.globs ? parseGlobs(typedParams.globs) : undefined;
        const tags = typedParams.tags
          ? typedParams.tags.split(",").map((tag: string) => tag.trim())
          : undefined;

        // Prepare metadata updates
        const meta: Record<string, any> = {};

        if (typedParams.name !== undefined) meta.name = typedParams.name;
        if (typedParams.description !== undefined) meta.description = typedParams.description;
        if (globs !== undefined) meta.globs = globs;
        if (tags !== undefined) meta.tags = tags;

        // Convert format
        const format = typedParams.format as RuleFormat | undefined;

        // Call domain function
        const rule = await ruleService.updateRule(
          typedParams.id,
          {
            content,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
          },
          {
            format,
            debug: typedParams.debug,
          }
        );

        return {
          success: true,
          rule,
        };
      } catch (error) {
        log.error("Failed to update rule", {
          error: getErrorMessage(error),
          id: typedParams.id,
        });
        throw error;
      }
    },
  });

  // Register rules compile command
  targetRegistry.registerCommand({
    id: "rules.compile",
    category: CommandCategory.RULES,
    name: "compile",
    description: "Compile rules into a monolithic file (e.g., AGENTS.md or CLAUDE.md)",
    parameters: {
      target: {
        schema: z.string(),
        description:
          "Target file type to compile to (e.g., agents.md, claude.md). Defaults to agents.md.",
        required: false,
        defaultValue: "agents.md",
      },
      output: {
        schema: z.string().optional(),
        description: "Output file path (defaults to the target's default output path)",
        required: false,
      },
      dryRun: {
        schema: z.boolean(),
        description: "Print compiled content to output without writing to file",
        required: false,
        defaultValue: false,
      },
      check: {
        schema: z.boolean(),
        description:
          "Check if the output file is up-to-date (staleness detection). Exits non-zero if stale.",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      log.debug("Executing rules.compile command", { params });

      const typedParams = params as {
        target?: string;
        output?: string;
        dryRun?: boolean;
        check?: boolean;
      };

      const targetId = typedParams.target || "agents.md";

      try {
        const { createCompileService, agentsMdTarget, claudeMdTarget } = await import(
          "../../../domain/rules/compile"
        );

        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        const compileService = createCompileService();

        // For check mode, do a dry-run first to get the compiled content
        if (typedParams.check) {
          const dryResult = await compileService.compile(ruleService, targetId, {
            workspacePath,
            outputPath: typedParams.output,
            dryRun: true,
          });

          // Determine the output path for the target
          const targetMap: Record<string, { defaultOutputPath(w: string): string }> = {
            "agents.md": agentsMdTarget,
            "claude.md": claudeMdTarget,
          };
          const targetObj = targetMap[targetId];
          const outputFilePath =
            typedParams.output ||
            (targetObj ? targetObj.defaultOutputPath(workspacePath) : `${workspacePath}/OUT.md`);

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
          workspacePath,
          outputPath: typedParams.output,
          dryRun: typedParams.dryRun || false,
        });

        if (typedParams.dryRun) {
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
      } catch (error) {
        log.error("Failed to compile rules", {
          error: getErrorMessage(error),
          target: targetId,
        });
        throw error;
      }
    },
  });

  // Register rules migrate command
  targetRegistry.registerCommand({
    id: "rules.migrate",
    category: CommandCategory.RULES,
    name: "migrate",
    description: "Migrate rules from .cursor/rules/ to .minsky/rules/",
    parameters: {
      dryRun: {
        schema: z.boolean(),
        description: "Show what would be migrated without doing it",
        required: false,
        defaultValue: false,
      },
      force: {
        schema: z.boolean(),
        description: "Overwrite existing files in destination",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params: { dryRun?: boolean; force?: boolean }) => {
      log.debug("Executing rules.migrate command", { params });

      const dryRun = params.dryRun || false;
      const force = params.force || false;

      try {
        const workspacePath = await resolveWorkspacePath({});
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
            "Run `minsky rules compile --target cursor-rules` to regenerate .cursor/rules/ from the new canonical source",
            "Add `.cursor/rules/` to your .gitignore",
            "Run `git rm -r --cached .cursor/rules/` to untrack the old files",
          ],
        };
      } catch (error) {
        log.error("Failed to migrate rules", {
          error: getErrorMessage(error as any),
        });
        throw error;
      }
    },
  });

  // Register rules search command
  targetRegistry.registerCommand({
    id: "rules.search",
    category: CommandCategory.RULES,
    name: "search",
    description: "Search for rules by content or metadata",
    parameters: rulesSearchCommandParams,
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      log.debug("Executing rules.search command", { params });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});

        // Use similarity service (consistent with tasks.search)
        const { createRuleSimilarityService } = await import(
          "../../../domain/rules/rule-similarity-service"
        );
        const service = await createRuleSimilarityService();

        const query = params.query;
        const limit = params.limit ?? 10;
        const threshold = params.threshold;

        // Emit progress message like tasks.search does
        const quiet = Boolean(params.quiet);
        const json = Boolean(params.json) || ctx?.format === "json";
        if (!quiet && !json && query) {
          log.cliWarn(`Searching for rules matching: "${query}" ...`);
        }

        // Perform similarity search (consistent with tasks.search)
        const results = await service.searchByText(query, limit, threshold);

        // Optional human-friendly diagnostics (consistent with tasks.search)
        if (params.details) {
          try {
            const cfg = await (await import("../../../domain/configuration")).getConfiguration();
            const provider =
              (cfg as any).embeddings?.provider || (cfg as any).ai?.defaultProvider || "openai";
            const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
            const effThreshold = threshold ?? "(default)";
            log.cliWarn(`Search provider: ${provider}`);
            log.cliWarn(`Model: ${model}`);
            log.cliWarn(`Limit: ${limit}`);
            log.cliWarn(`Threshold: ${String(effThreshold)}`);
          } catch {
            // ignore diagnostics failures
          }
        }

        // Enhance results with rule details (similar to tasks.search)
        const enhancedResults: Array<{
          id: string;
          score: number;
          name: string;
          description: string;
          format: string;
        }> = [];
        for (const result of results) {
          try {
            // Get full rule details
            const { ModularRulesService } = await import(
              "../../../domain/rules/rules-service-modular"
            );
            const rulesService = new ModularRulesService(workspacePath);
            const rule = await rulesService.getRule(result.id);

            enhancedResults.push({
              id: result.id,
              score: result.score,
              name: rule.name || result.id,
              description: rule.description || rule.name || "",
              format: rule.format || "",
            });
          } catch (error) {
            // Rule not found or error loading rule, include minimal info
            enhancedResults.push({
              id: result.id,
              score: result.score,
              name: result.id,
              description: "",
              format: "",
            });
          }
        }

        return {
          success: true,
          count: enhancedResults.length,
          results: enhancedResults, // Use same format as tasks.search
          details: params.details,
        };
      } catch (error) {
        log.error("Failed to search rules", {
          error: getErrorMessage(error as any),
          query: (params as any).query,
        });
        throw error;
      }
    },
  });

  // ─── Rule selection commands ────────────────────────────────────────────────

  // Register rules.enable command
  targetRegistry.registerCommand({
    id: "rules.enable",
    category: CommandCategory.RULES,
    name: "enable",
    description: "Add a rule ID to the enabled list in the project config",
    parameters: {
      ruleId: {
        schema: z.string(),
        description: "The rule ID to enable",
        required: true,
      },
    },
    execute: async (params: { ruleId: string }) => {
      const workspacePath = await resolveWorkspacePath({});
      const config = await readRulesSelectionConfig(workspacePath);

      if (!config.enabled.includes(params.ruleId)) {
        config.enabled.push(params.ruleId);
      }
      // Remove from disabled if present
      config.disabled = config.disabled.filter((id) => id !== params.ruleId);

      await writeRulesSelectionConfig(workspacePath, config);
      return {
        success: true,
        ruleId: params.ruleId,
        enabled: config.enabled,
        disabled: config.disabled,
      };
    },
  });

  // Register rules.disable command
  targetRegistry.registerCommand({
    id: "rules.disable",
    category: CommandCategory.RULES,
    name: "disable",
    description: "Add a rule ID to the disabled list in the project config",
    parameters: {
      ruleId: {
        schema: z.string(),
        description: "The rule ID to disable",
        required: true,
      },
    },
    execute: async (params: { ruleId: string }) => {
      const workspacePath = await resolveWorkspacePath({});
      const config = await readRulesSelectionConfig(workspacePath);

      if (!config.disabled.includes(params.ruleId)) {
        config.disabled.push(params.ruleId);
      }
      // Remove from enabled if present
      config.enabled = config.enabled.filter((id) => id !== params.ruleId);

      await writeRulesSelectionConfig(workspacePath, config);
      return {
        success: true,
        ruleId: params.ruleId,
        enabled: config.enabled,
        disabled: config.disabled,
      };
    },
  });

  // Register rules.config command
  targetRegistry.registerCommand({
    id: "rules.config",
    category: CommandCategory.RULES,
    name: "config",
    description: "Show current rule selection state (presets, enabled, disabled)",
    parameters: {},
    execute: async () => {
      const workspacePath = await resolveWorkspacePath({});
      const config = await readRulesSelectionConfig(workspacePath);

      // Get all rule IDs to compute active count
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
    },
  });

  // Register rules.presets command
  targetRegistry.registerCommand({
    id: "rules.presets",
    category: CommandCategory.RULES,
    name: "presets",
    description: "List available rule presets with their rule counts",
    parameters: {},
    execute: async () => {
      const presets = Object.entries(RULE_PRESETS).map(([name, ruleIds]) => ({
        name,
        ruleCount: ruleIds.length,
        rules: ruleIds,
      }));
      return { success: true, presets };
    },
  });
}

// ─── Config read/write helpers ──────────────────────────────────────────────

interface RulesSelectionConfig {
  presets: string[];
  enabled: string[];
  disabled: string[];
}

/**
 * Read the rules selection config (presets/enabled/disabled) from the project
 * config file (.minsky/config.yaml). Returns defaults if file doesn't exist.
 */
async function readRulesSelectionConfig(workspacePath: string): Promise<RulesSelectionConfig> {
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
async function writeRulesSelectionConfig(
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
