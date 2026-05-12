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
import type { StrikeTracker } from "../../domain/ask/strike-tracker";
import { normalizeErrorSignature } from "../../domain/ask/strike-tracker";
import type { AskRepository } from "../../domain/ask/repository";

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
      /**
       * Per-argument defaults applied at the MCP layer only (mt#1786).
       *
       * Merged into the caller's args before parameter conversion: any key in
       * `argDefaults` whose value the caller did not provide is filled in from
       * here. Explicit caller values always win. This is how MCP-only defaults
       * are expressed without changing the underlying shared command's CLI
       * behavior (which doesn't read this field).
       *
       * Used by `tasks.list` to default `limit: 50` so a default MCP call
       * returns a digestible result instead of the full active-task list.
       */
      argDefaults?: Record<string, unknown>;
    }
  >;
  /** Whether to enable debug logging */
  debug?: boolean;
  /** DI container — passed from MCP startup, avoids getAppContainer() Service Locator */
  container?: import("../../composition/types").AppContainerInterface;
  /**
   * Optional 2-strikes tracker (mt#1464).
   * When provided, every MCP tool error increments the counter; a 2nd identical
   * error on the same (taskId, toolName) pair fires a `stuck.unblock` Ask.
   */
  strikeTracker?: StrikeTracker;
  /**
   * Optional Ask repository for emitting `stuck.unblock` Asks on strike-2.
   * Failures are best-effort — they never block the command error path.
   */
  askRepository?: AskRepository;
}

/** Classifier version tag for 2-strikes `stuck.unblock` Asks (mt#1464). */
const STRIKES_CLASSIFIER_VERSION = "v1.0.0";

/**
 * Serialize one attempt payload into a JSON-safe object.
 *
 * Error instances serialize to `{}` by default because their properties
 * are non-enumerable. This helper extracts `name`, `code`, and `message`
 * explicitly so the Ask metadata round-trips cleanly via
 * JSON.parse(JSON.stringify(...)) and does not leak raw Error objects.
 *
 * `stack` is intentionally omitted: stack traces can expose file paths,
 * internal hostnames, env details, and (in some Error subclasses) wrapped
 * tokens — a security risk for Ask metadata that may be persisted or
 * transmitted externally.
 */
function serializeAttempt(payload: unknown): unknown {
  if (payload instanceof Error) {
    const err = payload as Error & { code?: unknown };
    return {
      name: err.name,
      code: err.code !== undefined ? err.code : undefined,
      message: err.message,
      // stack omitted: security — can leak file paths, hostnames, and tokens
    };
  }
  // Primitives: coerce to string so metadata is JSON-safe.
  if (payload === null || typeof payload !== "object") {
    return String(payload);
  }
  // Plain objects (non-Error throws): whitelist only `{name, code, message}`.
  // Other fields may carry stack frames, request/response bodies, headers,
  // tokens, file paths, or env details — we drop everything outside the
  // whitelist to prevent leakage when metadata is persisted or routed externally.
  const obj = payload as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  if (typeof obj.name === "string") safe.name = obj.name;
  if (obj.code !== undefined && (typeof obj.code === "string" || typeof obj.code === "number")) {
    safe.code = obj.code;
  }
  if (typeof obj.message === "string") safe.message = obj.message;
  return safe;
}

/**
 * Best-effort emission of a `stuck.unblock` Ask on the 2nd identical MCP error.
 *
 * Called from the MCP command error path when `count === 2`. Failures are
 * caught by the caller — this function must never throw.
 */
async function emitStuckUnblockAsk(params: {
  askRepository: AskRepository;
  taskId: string | undefined;
  sessionId: string | undefined;
  toolName: string;
  attempts: unknown[];
}): Promise<void> {
  const { askRepository, taskId, sessionId, toolName, attempts } = params;
  // Build a valid AgentId per ADR-006: {kind}:{scope}:{id}
  const requestor = sessionId
    ? `minsky.mcp:session:${sessionId}`
    : taskId
      ? `minsky.mcp:task:${taskId}`
      : "minsky.mcp:unknown:unknown";
  // Serialize attempts before storing: Error instances serialize to {} by
  // default (non-enumerable properties). serializeAttempt extracts only
  // {name, code, message} so metadata round-trips via JSON; stack is
  // intentionally omitted for security (file paths, env, wrapped tokens),
  // and non-Error payloads are whitelisted to the same fields.
  const serializedAttempts = attempts.map(serializeAttempt);
  await askRepository.create({
    kind: "stuck.unblock",
    classifierVersion: STRIKES_CLASSIFIER_VERSION,
    requestor,
    parentTaskId: taskId,
    parentSessionId: sessionId,
    title: `MCP tool ${toolName} failed twice with same error`,
    question: `The MCP tool "${toolName}" has produced the same error signature twice in a row. Prior attempts are in metadata.`,
    metadata: { priorAttempts: serializedAttempts },
  });
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
        mutating: command.mutating,
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

            // Convert MCP args to expected parameter format.
            //
            // Apply MCP-only argDefaults (mt#1786) BEFORE conversion: each key
            // from the override's argDefaults is filled in only when the caller
            // omitted it. Explicit caller values always win. This lets the MCP
            // adapter shape default behavior (e.g., default `tasks.list` to
            // `limit: 50`) without affecting CLI defaults defined on the
            // underlying shared command.
            const filteredArgs: Record<string, unknown> = { ...args };
            const argDefaults = overrides?.argDefaults;
            if (argDefaults) {
              for (const [key, value] of Object.entries(argDefaults)) {
                if (filteredArgs[key] === undefined) {
                  filteredArgs[key] = value;
                }
              }
            }
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

            // 2-strikes success path: clear strikes for this (taskId, toolName) pair.
            // MCP commands signal errors exclusively by throwing — there is no { ok: false }
            // non-throw contract here, so a non-throwing return always means success.
            if (config.strikeTracker) {
              // When args.task is absent, key by sessionId so unrelated sessions
              // hitting the same tool don't share a strike counter. Falling back
              // to "_global" would collapse all task-less commands into one bucket,
              // causing false 2-strikes across sessions. (mt#1464 R2 fix)
              const sessionId = typeof args?.session === "string" ? args.session : undefined;
              const taskId = typeof args?.task === "string" ? args.task : (sessionId ?? "unknown");
              config.strikeTracker.recordSuccess(taskId, command.id);
            }

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

            // 2-strikes error path (mt#1464): record the strike.
            // On strike-2, emit a stuck.unblock Ask — best-effort, never blocks the throw.
            if (config.strikeTracker) {
              // When args.task is absent, key by sessionId so unrelated sessions
              // hitting the same tool don't share a strike counter. Falling back
              // to "_global" would collapse all task-less commands into one bucket,
              // causing false 2-strikes across sessions. (mt#1464 R2 fix)
              const sessionId = typeof args?.session === "string" ? args.session : undefined;
              const taskId = typeof args?.task === "string" ? args.task : (sessionId ?? "unknown");
              const errorSig = normalizeErrorSignature(error);
              const strikeResult = config.strikeTracker.recordError(
                { taskId, toolName: command.id, errorSignature: errorSig },
                error
              );

              if (strikeResult.count === 2 && config.askRepository) {
                emitStuckUnblockAsk({
                  askRepository: config.askRepository,
                  taskId: typeof args?.task === "string" ? args.task : undefined,
                  sessionId,
                  toolName: command.id,
                  attempts: strikeResult.attempts,
                }).catch((emitErr) => {
                  log.warn(`[2-strikes] Failed to emit stuck.unblock Ask: ${emitErr}`);
                });
              }
            }

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
 * Register memory commands with MCP
 */
export function registerMemoryCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.MEMORY],
    ...config,
  });
}

/**
 * Register detector commands with MCP (attention-allocation noticer family —
 * `unasked-direction.*` per mt#1543 / Surface 4, `epic-decomposition.audit`
 * per mt#1710 / Shape C, and future System 3* detector surfaces).
 *
 * Follows the MEMORY single-path model — invoked once via the per-category
 * adapter `registerDetectorsTools` in `start-command.ts`; intentionally NOT
 * listed in `registerAllMainCommandsWithMcp`'s category set, pending the
 * mt#1521 source-of-truth resolution.
 */
export function registerDetectorsCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.DETECTORS],
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
 * Register workspace commands with MCP (e.g., workspace.info)
 */
export function registerWorkspaceCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.WORKSPACE],
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
 * Register all main command categories with MCP.
 *
 * MEMORY and DETECTORS are intentionally NOT in this list. Their commands are
 * registered solely via the per-category adapters (`registerMemoryTools`,
 * `registerDetectorsTools`) invoked by `start-command.ts`. The dual-registration
 * shape that other categories exhibit (listed here AND independently registered
 * in start-command) is a latent silent-overwrite hazard via
 * `MinskyMCPServer.addTool()`'s Map semantics; mt#1521 owns the structural
 * source-of-truth resolution that may apply this same exclusion to the other
 * categories. Until then, MEMORY and DETECTORS are the model.
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
      CommandCategory.WORKSPACE,
      CommandCategory.TRANSCRIPTS,
    ],
    ...config,
  });
}
