/**
 * Shared Command Integration for MCP
 *
 * This module provides utilities for automatically registering shared commands
 * with the MCP command mapper, eliminating the need for manual command duplication.
 */

import type { CommandMapper } from "../../mcp/command-mapper";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../shared/command-registry";
import { log } from "../../utils/logger";
import { redact } from "../../utils/redaction";
import { z } from "zod";
import { guardProjectSetup } from "../../domain/configuration/guard";

/**
 * Test whether a Zod schema accepts boolean values.
 *
 * Used to gate the MCP bridge's `params.json = true` override so it only
 * fires on commands whose `json` parameter is a formatting flag, not a
 * non-formatting parameter that happens to be named `json` (e.g., a JSON
 * payload string).
 *
 * safeParse is preferred over `instanceof z.ZodBoolean` because it:
 *   - Accepts wrapped schemas: `z.boolean().optional()`, `z.boolean().default(false)`, `z.preprocess(...)` wrapping a boolean.
 *   - Is immune to duplicate-zod-instance identity issues that can arise from monorepo / pnpm dedupe.
 */
function isBooleanCompatibleSchema(schema: z.ZodType): boolean {
  return schema.safeParse(true).success && schema.safeParse(false).success;
}

/**
 * Convert shared command parameters to a Zod schema that MCP can use
 */
export function convertParametersToZodSchema(
  parameters: CommandParameterMap
): z.ZodObject<Record<string, z.ZodType>> {
  // If no parameters, return empty object schema
  if (!parameters || Object.keys(parameters).length === 0) {
    return z.object({});
  }

  const shape: Record<string, z.ZodType> = {};

  for (const [key, param] of Object.entries(parameters)) {
    // Skip the json parameter in MCP context since MCP always returns JSON
    if (key === "json") {
      continue;
    }

    let schema = param.schema;

    // Make optional if not required.
    // Use z.optional(schema) (functional form) rather than schema.optional() so
    // this is immune to:
    //   (a) plain-object schemas that don't have the .optional() method, and
    //   (b) duplicate-zod-instance issues (monorepo / pnpm dedupe) where the
    //       schema's prototype chain doesn't match the local z.ZodType class.
    if (!param.required) {
      schema = z.optional(schema as z.ZodTypeAny);
    }

    // Add default value if present.
    // Guard with a typeof check for the same reasons as above.
    if (param.defaultValue !== undefined) {
      const schemaAny = schema as z.ZodTypeAny;
      if (typeof schemaAny.default === "function") {
        schema = schemaAny.default(param.defaultValue);
      }
    }

    shape[key] = schema;
  }

  const zodSchema = z.object(shape);

  log.debug("Converting parameters to Zod schema", {
    parameterCount: Object.keys(parameters).length,
    parameterKeys: Object.keys(parameters),
    shapeKeys: Object.keys(shape),
    zodSchemaType:
      "_zod" in zodSchema ? (zodSchema._zod as { def?: { type?: string } }).def?.type : undefined,
  });

  return zodSchema;
}

/**
 * Convert MCP args to the format expected by shared commands
 */
function convertMcpArgsToParameters(
  args: Record<string, unknown>,
  parameterDefs: CommandParameterMap
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, paramDef] of Object.entries(parameterDefs)) {
    const value = args[key];

    if (value !== undefined) {
      // Use the value as-is since it should already be validated by MCP
      result[key] = value;
    } else if (paramDef.defaultValue !== undefined) {
      // Use default value
      result[key] = paramDef.defaultValue;
    }
    // For required parameters, rely on Zod validation to catch missing values
  }

  return result;
}

/**
 * Configuration for MCP shared command registration
 */
export interface McpSharedCommandConfig {
  /** Array of command categories to register */
  categories: CommandCategory[];
  /** Command-specific overrides */
  commandOverrides?: Record<
    string,
    {
      /** Override command description */
      description?: string;
      /** Override command spec */
      spec?: string;
      /** Hide command from MCP */
      hidden?: boolean;
    }
  >;
  /** Whether to enable debug logging */
  debug?: boolean;
  /** DI container — passed from MCP startup, avoids getAppContainer() Service Locator */
  container?: import("../../composition/types").AppContainerInterface;
}

/**
 * Register shared commands with MCP using the bridge
 */
export function registerSharedCommandsWithMcp(
  commandMapper: CommandMapper,
  config: McpSharedCommandConfig
): void {
  log.debug("Registering shared commands with MCP", {
    categories: config.categories,
    overrides: config.commandOverrides ? Object.keys(config.commandOverrides) : [],
  });

  // Register commands for each category
  config.categories.forEach((category) => {
    const commands = sharedCommandRegistry.getCommandsByCategory(category);

    commands.forEach((command) => {
      const overrides = config.commandOverrides?.[command.id];

      // Skip hidden commands
      if (overrides?.hidden) {
        return;
      }

      const description = overrides?.description || command.description;

      log.debug(`Registering command ${command.id} with MCP`, {
        category,
        description,
      });

      // Register command with MCP using the command mapper
      // Convert shared command parameters to MCP-compatible format
      commandMapper.addCommand({
        name: command.id,
        description,
        parameters: convertParametersToZodSchema(command.parameters),
        handler: async (args: Record<string, unknown>) => {
          const startTime = Date.now();
          log.debug(`[MCP] Starting command execution: ${command.id}`, { args: redact(args) });

          try {
            // Create execution context for shared command.
            // MCP is a structured-data interface — always use JSON format so
            // commands' formatResult() returns structured data, not human-
            // readable text that discards the underlying payload.
            const context: CommandExecutionContext = {
              interface: "mcp",
              debug: args?.debug === true || args?.debug === "true",
              format: "json",
              container: config.container,
            };
            // Omit `container` from debug logs: it holds the full DI container,
            // which is expensive to walk and produces huge [Circular]-laden output.
            const { container: _container, ...safeCtx } = context;
            log.debug(`[MCP] Created execution context: ${command.id}`, {
              context: redact(safeCtx),
            });

            // Convert MCP args to expected parameter format
            const filteredArgs = { ...args };
            log.debug(`[MCP] Processing args: ${command.id}`, {
              filteredArgs: redact(filteredArgs),
            });

            const parameters = { ...convertMcpArgsToParameters(filteredArgs, command.parameters) };
            // Force json=true so commands that gate on params.json (rather
            // than ctx.format) return structured data to MCP callers. The
            // `json` parameter is stripped from the MCP-facing schema, so
            // clients never set it — we set it here for the bridge.
            //
            // Only override when the parameter's schema accepts boolean values,
            // so a command that happens to name a non-formatting parameter
            // `json` (e.g., a JSON payload string) is not silently mutated.
            // Probe with safeParse(true) && safeParse(false) rather than
            // `instanceof z.ZodBoolean` so wrapped schemas like
            // `z.boolean().optional()` or `z.boolean().default(false)` are
            // also matched, and the check is immune to duplicate-zod-instance
            // identity issues (monorepo/pnpm dedupe).
            const jsonParamDef = command.parameters?.json;
            if (jsonParamDef && isBooleanCompatibleSchema(jsonParamDef.schema)) {
              parameters.json = true;
            }
            log.debug(`[MCP] Converted parameters: ${command.id}`, {
              parameters: redact(parameters),
            });

            // Guard: verify the project is initialized before executing non-exempt commands
            if (command.requiresSetup !== false) {
              guardProjectSetup(command.id);
            }

            // ADR-004: validate→execute pipeline
            let validatedCtx: unknown;
            if (command.validate) {
              validatedCtx = await command.validate(parameters, context);
            }

            // Execute the shared command (no timeout - debug actual hang)
            log.debug(`[MCP] About to execute command: ${command.id}`);
            log.debug(`[MCP] Parameters being passed:`, redact(parameters));
            // Re-use safeCtx (container already stripped) for the second log site.
            log.debug(`[MCP] Context being passed:`, { context: redact(safeCtx) });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await command.execute(parameters, context, validatedCtx as any);

            const duration = Date.now() - startTime;
            log.debug(`[MCP] Command completed: ${command.id}`, { duration });
            return result as string | Record<string, unknown>;
          } catch (error) {
            const duration = Date.now() - startTime;

            // CRITICAL: Check for undefined reference errors that could indicate missing imports
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isUndefinedReference =
              errorMessage.includes("is not defined") ||
              errorMessage.includes("undefined") ||
              errorMessage.includes("ReferenceError");

            if (isUndefinedReference) {
              log.error(`🚨 CRITICAL: Possible missing import detected in ${command.id}`, {
                error: errorMessage,
                duration,
                suggestion: "Check for missing imports in the command implementation",
              });
            }

            log.error(`[MCP] Command failed: ${command.id}`, {
              error: errorMessage,
              duration,
              isUndefinedReference,
            });
            throw error;
          }
        },
      });
    });
  });
}

/**
 * Register task commands with MCP
 */
export function registerTaskCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.TASKS],
    ...config,
  });
}

/**
 * Register git commands with MCP
 */
export function registerGitCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.GIT],
    ...config,
  });
}

/**
 * Register repo exploration commands with MCP
 */
export function registerRepoCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.REPO],
    ...config,
  });
}

/**
 * Register session commands with MCP
 */
export function registerSessionCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.SESSION],
    ...config,
  });
}

/**
 * Register rules commands with MCP
 */
export function registerRulesCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.RULES],
    ...config,
  });
}

/**
 * Register config commands with MCP
 */
export function registerConfigCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.CONFIG],
    ...config,
  });
}

/**
 * Register init commands with MCP
 */
export function registerInitCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.INIT],
    ...config,
  });
}

/**
 * Register debug commands with MCP
 */
export function registerDebugCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.DEBUG],
    ...config,
  });
}

/**
 * Register tools commands with MCP (includes validate.lint, validate.typecheck, and other TOOLS-category commands)
 */
export function registerToolsCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.TOOLS],
    ...config,
  });
}

/**
 * Register persistence commands with MCP
 */
export function registerPersistenceCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.PERSISTENCE],
    ...config,
  });
}

/**
 * Register sessiondb commands with MCP (legacy compatibility)
 */
export function registerSessiondbCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  // Forward to persistence commands for backward compatibility
  registerPersistenceCommandsWithMcp(commandMapper, config);
}

/**
 * Register changeset commands with MCP (repository changesets and session aliases)
 */
export function registerChangesetCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.REPO],
    ...config,
  });
}

/**
 * Register MCP management commands with MCP (e.g., mcp.register)
 */
export function registerMcpCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.MCP],
    ...config,
  });
}

/**
 * Register knowledge commands with MCP
 */
export function registerKnowledgeCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.KNOWLEDGE],
    ...config,
  });
}

/**
 * Register authorship commands with MCP.
 *
 * This is the **least-privilege MCP entry point** for the authorship namespace.
 * Reviewer-style deployments that should NOT have access to the full provenance
 * record (transcript IDs, participants, substantive human input, etc.) should
 * call this function instead of `registerAllMainCommandsWithMcp` — the latter
 * intentionally exposes both `provenance.*` and `authorship.*` for admin/CLI use.
 *
 * The narrowing happens at two layers:
 *   1. Server surface: this function exposes only `CommandCategory.AUTHORSHIP`.
 *   2. Response shape: `authorship.get` returns `{ tier, rationale?, policyVersion?, judgingModel? }`,
 *      not the full ProvenanceRecord (see `authorship.ts`).
 *
 * `provenance.get` and `provenance.recompute` (deprecated alias) remain available
 * via `registerProvenanceCommandsWithMcp` / `registerAllMainCommandsWithMcp` for
 * admin and CLI consumers — that surface is INTENTIONAL, per mt#1227 / mt#1254.
 */
export function registerAuthorshipCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.AUTHORSHIP],
    ...config,
  });
}

/**
 * Register provenance commands with MCP
 */
export function registerProvenanceCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.PROVENANCE],
    ...config,
  });
}

/**
 * Register all main command categories with MCP
 */
export function registerAllMainCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [
      CommandCategory.TASKS,
      CommandCategory.GIT,
      CommandCategory.REPO,
      CommandCategory.SESSION,
      CommandCategory.RULES,
      CommandCategory.CONFIG,
      CommandCategory.INIT,
      CommandCategory.DEBUG,
      CommandCategory.PERSISTENCE,
      CommandCategory.MCP,
      CommandCategory.KNOWLEDGE,
      CommandCategory.PROVENANCE,
      CommandCategory.AUTHORSHIP,
    ],
    ...config,
  });
}
