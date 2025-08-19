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
import { getEmbeddingDimension } from "../../../domain/ai/embedding-models";
import { createEmbeddingServiceFromConfig } from "../../../domain/ai/embedding-service-factory";
import { PostgresVectorStorage } from "../../../domain/storage/vector/postgres-vector-storage";
import postgres from "postgres";

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
};

const rulesIndexEmbeddingsParams: CommandParameterMap = composeParams(
  {
    limit: {
      schema: z.number().int().positive().optional(),
      description: "Limit number of rules to index (for debugging)",
      required: false,
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
  format?: "cursor" | "openai";
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
    schema: z.enum(["cursor", "openai"]),
    description: "Rule format for file system organization (cursor or openai)",
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
  json?: boolean;
  debug?: boolean;
};

const rulesSearchCommandParams: CommandParameterMap = composeParams(
  {
    query: RulesParameters.query,
    format: RulesParameters.format,
    tag: RulesParameters.tag,
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
        const cfg = await getConfiguration();
        const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
        const dimension = getEmbeddingDimension(model, 1536);

        const conn = (cfg as any).sessiondb?.postgres?.connectionString;
        if (!conn) {
          throw new Error("PostgreSQL connection string not configured (sessiondb.postgres)");
        }

        // Ensure rules_embeddings table exists (extension, table, index)
        const sql = postgres(conn, { prepare: false, onnotice: () => {} });
        const vectorDim = String(dimension);
        await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
        await sql.unsafe(
          `CREATE TABLE IF NOT EXISTS rules_embeddings (
            rule_id TEXT PRIMARY KEY,
            dimension INT NOT NULL,
            embedding VECTOR(${vectorDim}),
            metadata JSONB,
            content_hash TEXT,
            last_indexed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          )`
        );
        // Ensure new columns exist if table was created by an older version
        await sql.unsafe(
          `ALTER TABLE rules_embeddings
             ADD COLUMN IF NOT EXISTS metadata JSONB,
             ADD COLUMN IF NOT EXISTS content_hash TEXT,
             ADD COLUMN IF NOT EXISTS last_indexed_at TIMESTAMPTZ,
             ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
             ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`
        );
        // Create HNSW index if not exists
        await sql.unsafe(
          `DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname = 'idx_rules_embeddings_hnsw' AND n.nspname = 'public'
            ) THEN
              EXECUTE 'CREATE INDEX idx_rules_embeddings_hnsw ON rules_embeddings USING hnsw (embedding vector_l2_ops)';
            END IF;
          END$$;`
        );
        await sql.end({ timeout: 1 });

        // Initialize embedding service and storage
        const embeddingService = await createEmbeddingServiceFromConfig();
        const storage = await PostgresVectorStorage.fromSessionDbConfig(dimension, {
          tableName: "rules_embeddings",
          idColumn: "rule_id",
          embeddingColumn: "embedding",
          dimensionColumn: "dimension",
          lastIndexedAtColumn: "last_indexed_at",
          metadataColumn: "metadata",
          contentHashColumn: "content_hash",
        });

        // Resolve workspace and list rules
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);
        const rules = await ruleService.listRules({});

        const limit = params.limit && params.limit > 0 ? params.limit : undefined;
        const slice = typeof limit === "number" ? rules.slice(0, limit) : rules;

        if (!params.json && ctx?.format !== "json") {
          log.cli(`Indexing embeddings for ${slice.length} rule(s)...`);
        }

        const start = Date.now();
        let indexed = 0;
        let skipped = 0;
        for (const rule of slice) {
          try {
            // Prefer full rule content; fallback to file; then to metadata
            let content = "";
            const rawFromRule = (rule as any).content;
            if (typeof rawFromRule === "string" && rawFromRule.trim().length > 0) {
              content = rawFromRule;
            } else if (typeof (rule as any).path === "string") {
              try {
                const fileText = await fs.readFile(String((rule as any).path), "utf-8");
                if (fileText && fileText.trim().length > 0) content = fileText;
              } catch {
                // ignore file read errors
              }
            }
            if (!content) {
              const textParts: string[] = [];
              if (rule.name) textParts.push(String(rule.name));
              if (rule.description) textParts.push(String(rule.description));
              if ((rule as any).tags && Array.isArray((rule as any).tags)) {
                textParts.push((rule as any).tags.join(" "));
              }
              // As a last resort include rule id
              if (textParts.length === 0) textParts.push(String(rule.id));
              content = textParts.join("\n\n");
            }
            // Limit content length to reasonable window
            const contentLimited = content.slice(0, 4000).trim();
            if (!contentLimited) {
              skipped += 1;
              continue;
            }

            const vector = await embeddingService.generateEmbedding(contentLimited);
            const metadata: any = { name: rule.name, description: rule.description };
            let contentHash: string | undefined;
            try {
              const { createHash } = await import("crypto");
              contentHash = createHash("sha256").update(contentLimited).digest("hex");
            } catch {}
            // Store metadata JSON and content hash in dedicated column for staleness detection
            await storage.store(rule.id, vector, { ...metadata, contentHash });
            indexed += 1;
          } catch (e) {
            // Skip problematic rule and continue; surface count in JSON
            skipped += 1;
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
            dimension,
            model,
          };
        }
        log.cli(`✅ Indexed ${indexed}/${slice.length} rule(s) in ${elapsed}ms (skipped: ${skipped})`);
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

        // Transform rules to exclude content field for better usability
        const rulesWithoutContent = rules.map(({ content, ...rule }) => rule);

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
          ruleFormat: (typedParams.format || "cursor") as "cursor" | "openai",
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
      log.debug("Executing rules.update command"!, { params });

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

  // Register rules search command
  targetRegistry.registerCommand({
    id: "rules.search",
    category: CommandCategory.RULES,
    name: "search",
    description: "Search for rules by content or metadata",
    parameters: rulesSearchCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.search command", { params });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert parameters
        const format = params.format as RuleFormat | undefined;

        // Call domain function
        const rules = await ruleService.searchRules({
          format,
          tag: params.tag,
          query: params.query,
        });

        return {
          success: true,
          rules,
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
}
