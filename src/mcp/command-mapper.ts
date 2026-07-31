import { z } from "zod";
import { log } from "@minsky/shared/logger";
import type { ProjectContext } from "../types/project";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { MinskyMCPServer, ToolDefinition, ToolProgressReporter } from "./server";

/**
 * Cross-cutting arg keys the framework itself reads even when a command does
 * not declare them (mt#2778): `debug` feeds the bridge's execution context
 * (shared-command-integration.ts), and `json` is stripped from MCP-facing
 * schemas and injected internally by the bridge. A caller sending either must
 * not be rejected by the undeclared-param check.
 *
 * Allowlisted keys deliberately PASS THROUGH to handlers unstripped (PR #1911
 * R1): the shared bridge consumes `debug` from the raw args before dropping
 * undeclared keys during parameter conversion, so stripping here would break
 * the bridge's debug context; direct-registered tools see them exactly as
 * they did pre-mt#2778 (pre-existing behavior preserved).
 */
const CROSS_CUTTING_ARG_KEYS: ReadonlySet<string> = new Set(["debug", "json"]);

/**
 * Walk through common Zod wrappers to reach an object shape (mt#2778, PR
 * #1911 R1 BLOCKING): a tool registered with a WRAPPED object schema —
 * `z.object(...).optional()` / `.default(...)` / `z.preprocess(fn, obj)` /
 * `obj.transform(fn)` — must get the same undeclared-param enforcement as a
 * bare object schema, not a silent fail-open.
 *
 * Wrapper traversal (verified against Zod 4.3.6):
 * - optional / default / nullable / readonly expose the wrapped schema via
 *   the public `.unwrap()` method (duck-typed).
 * - pipes (`z.preprocess`, `.transform`) expose `_zod.def.in` / `.out`; the
 *   object sits on `in` for transforms and `out` for preprocess. `in` is
 *   preferred when both sides are objects — callers send the input side.
 * - `_zod.def.innerType` covers wrapper types without `.unwrap()` (catch).
 *
 * Depth-bounded against pathological nesting. Returns undefined when no
 * object shape is reachable.
 */
function unwrapToObjectShape(schema: unknown, depth = 0): Record<string, unknown> | undefined {
  if (schema == null || typeof schema !== "object" || depth > 4) return undefined;
  const candidate = schema as {
    shape?: unknown;
    unwrap?: unknown;
    _zod?: { def?: { innerType?: unknown; in?: unknown; out?: unknown } };
  };
  const shape = candidate.shape;
  if (shape != null && typeof shape === "object" && !Array.isArray(shape)) {
    return shape as Record<string, unknown>;
  }
  if (typeof candidate.unwrap === "function") {
    try {
      const inner = (candidate.unwrap as () => unknown)();
      const innerShape = unwrapToObjectShape(inner, depth + 1);
      if (innerShape) return innerShape;
    } catch {
      // fall through to def-based traversal
    }
  }
  const def = candidate._zod?.def;
  if (def) {
    for (const next of [def.innerType, def.in, def.out]) {
      const innerShape = unwrapToObjectShape(next, depth + 1);
      if (innerShape) return innerShape;
    }
  }
  return undefined;
}

/**
 * Derive the declared parameter names from a tool's Zod schema (mt#2778).
 *
 * Returns undefined — meaning "cannot enforce; skip" — when the schema is
 * absent, is a plain-object legacy schema (mt#1200: no `safeParse`), or
 * yields no object shape even after wrapper traversal. The last case logs a
 * registration-time warning so the fail-open is visible, not silent (PR
 * #1911 R1). Duck-typed rather than `instanceof z.ZodObject` for the
 * duplicate-zod-instance reasons documented in shared-command-integration.ts
 * (monorepo/pnpm dedupe).
 */
function getDeclaredParamKeys(
  schema: z.ZodType | undefined,
  toolName: string
): ReadonlySet<string> | undefined {
  if (!schema) return undefined;
  const candidate: { safeParse?: unknown } = schema;
  if (typeof candidate.safeParse !== "function") return undefined;
  const shape = unwrapToObjectShape(schema);
  if (!shape) {
    log.warn("mcp.param_enforcement_disabled", {
      event: "mcp.param_enforcement_disabled",
      tool: toolName,
      reason:
        "Zod schema has no derivable object shape (even after wrapper traversal) — undeclared-param enforcement is disabled for this tool",
    });
    return undefined;
  }
  return new Set(Object.keys(shape));
}

/**
 * Reject undeclared tool params at the MCP dispatch boundary (mt#2778).
 *
 * The CallTool dispatch passes `request.params.arguments` to handlers without
 * runtime validation — the per-tool Zod schema historically fed only the
 * `tools/list` JSON-Schema declaration, which harness clients demonstrably do
 * not enforce (the mt#2737 incident class: a caller passing `taskId` to a
 * command declaring `task` silently got undefined-downstream behavior). Per
 * the MCP Tools spec (2025-06-18, Security Considerations), servers are
 * responsible for validating tool inputs; this is the key-set slice of that
 * validation. Value/type/required/default enforcement is deliberately out of
 * scope here (mt#2705 / mt#1638 own that trajectory).
 *
 * Escape hatch: MINSKY_MCP_ALLOW_UNKNOWN_PARAMS=1 downgrades rejection to a
 * structured warn log (`mcp.unknown_param_dropped`) for emergency rollback.
 *
 * Exported for unit tests.
 */
export function enforceDeclaredParams(
  toolName: string,
  args: Record<string, unknown>,
  declaredKeys: ReadonlySet<string> | undefined
): void {
  if (!declaredKeys) return;
  const unknownKeys = Object.keys(args).filter(
    (key) => !declaredKeys.has(key) && !CROSS_CUTTING_ARG_KEYS.has(key)
  );
  if (unknownKeys.length === 0) return;

  const knownKeys = [...declaredKeys].sort();
  if (process.env.MINSKY_MCP_ALLOW_UNKNOWN_PARAMS === "1") {
    log.warn("mcp.unknown_param_dropped", {
      event: "mcp.unknown_param_dropped",
      tool: toolName,
      unknownKeys,
      knownKeys,
    });
    return;
  }

  const plural = unknownKeys.length > 1 ? "s" : "";
  throw new Error(
    `Unknown parameter${plural} ${unknownKeys.map((k) => `"${k}"`).join(", ")} for "${toolName}". ` +
      `Known parameters: ${knownKeys.join(", ") || "(none)"}. ` +
      `Undeclared parameters are rejected at the MCP boundary (mt#2778); ` +
      `set MINSKY_MCP_ALLOW_UNKNOWN_PARAMS=1 to temporarily downgrade this to a warning.`
  );
}

/**
 * The CommandMapper class provides utilities for mapping Minsky CLI commands
 * to MCP tools using the official MCP SDK.
 */
export class CommandMapper {
  private server: MinskyMCPServer;
  private projectContext: ProjectContext | undefined;
  private registeredMethodNames: string[] = [];

  /**
   * Create a new CommandMapper
   * @param server The MinskyMCPServer instance
   * @param projectContext Optional project context containing repository information
   */
  constructor(server: MinskyMCPServer, projectContext?: ProjectContext) {
    this.server = server;
    this.projectContext = projectContext;

    if (projectContext) {
      log.debug("CommandMapper initialized with project context", {
        repositoryPath: projectContext.repositoryPath,
      });
    }
  }

  /**
   * Normalize method name for MCP tool registration.
   *
   * Strips any character outside `[a-zA-Z0-9._-]`. Dots are preserved for
   * backward-compat with existing dotted-name consumers (Reviewer service:
   * `session.list`, `session.pr.get`, `session.apply_post_merge_state_sync`).
   *
   * The Claude Desktop frontend validator uses the stricter regex
   * `^[a-zA-Z0-9_-]{1,64}$` (no dots). See `toClaudeDesktopName()` for the
   * underscored variant emitted in `tools/list`. mt#1779: tools register under
   * BOTH the dotted canonical name AND the underscored alias so Claude Desktop
   * can call them by name while legacy consumers using dotted names keep working.
   *
   * @param methodName Original method name (may contain dots for namespacing)
   * @returns Normalized canonical method name (may include dots)
   */
  private normalizeMethodName(methodName: string): string {
    return methodName.replace(/[^a-zA-Z0-9._-]/g, "");
  }

  /**
   * Get the project context (if available)
   * @returns The project context or undefined if not set
   */
  getProjectContext(): ProjectContext | undefined {
    return this.projectContext;
  }

  /**
   * Convert a Zod schema to a JSON Schema for MCP tool registration
   * @param zodSchema The Zod schema to convert
   * @returns JSON Schema object
   */
  public zodToJsonSchema(zodSchema: z.ZodType): Record<string, unknown> {
    try {
      const jsonSchema = z.toJSONSchema(zodSchema, {
        unrepresentable: "any",
        reused: "inline",
      }) as Record<string, unknown>;

      // Post-process: remove defaulted fields from `required`.
      // Zod v4's z.toJSONSchema() marks every field as required unless explicitly
      // `.optional()`. Fields with `.default()` should not be required for MCP tools
      // because external agents should not have to pass defaulted params explicitly.
      if (
        Array.isArray(jsonSchema.required) &&
        jsonSchema.properties != null &&
        typeof jsonSchema.properties === "object"
      ) {
        const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
        const filteredRequired = (jsonSchema.required as string[]).filter((key) => {
          const prop = properties[key];
          return !(prop != null && "default" in prop);
        });
        if (filteredRequired.length === 0) {
          delete jsonSchema.required;
        } else {
          jsonSchema.required = filteredRequired;
        }
      }

      log.debug("Converted Zod to JSON Schema", {
        zodType:
          "_zod" in zodSchema
            ? (zodSchema._zod as { def?: { type?: string } }).def?.type
            : undefined,
        jsonSchema,
      });

      return jsonSchema;
    } catch (error) {
      log.warn("Failed to convert Zod schema to JSON Schema, using fallback", {
        error: getErrorMessage(error),
      });

      // Return a permissive fallback schema
      return {
        type: "object",
        properties: {},
        additionalProperties: true,
      };
    }
  }

  /**
   * Add a command to the MCP server as a tool
   * @param command Command configuration object
   *
   * Provide EITHER `handler` (eager, legacy form) OR `getHandler` (lazy thunk,
   * mt#1792). When `getHandler` is provided without `handler`, the tool is
   * registered with a lazy thunk; the CallTool dispatch resolves it on first
   * call and caches the result. Both forms can coexist in the registry.
   */
  addCommand(command: {
    name: string;
    description: string;
    parameters?: z.ZodType;
    handler?: (
      args: Record<string, unknown>,
      context?: ProjectContext,
      progress?: ToolProgressReporter
    ) => Promise<string | Record<string, unknown>>;
    /**
     * mt#1792: lazy handler thunk. When provided (without `handler`), the tool
     * module is imported on first call instead of at registration time.
     * The thunk receives the ProjectContext snapshot captured at addCommand
     * time, so it behaves identically to the eager form.
     */
    getHandler?: () => Promise<
      (
        args: Record<string, unknown>,
        context?: ProjectContext,
        progress?: ToolProgressReporter
      ) => Promise<string | Record<string, unknown>>
    >;
    /**
     * When true, the tool performs external side effects and will be refused
     * by the server when drift is detected (loaded commit !== workspace HEAD).
     */
    mutating?: boolean;
    /**
     * mt#1751: when explicitly `false`, this command does NOT require the DI
     * container to be initialized — the CallTool handler skips the init
     * await for it. Default (unset/`true`) is to await DI init, which is
     * the safe choice for any command whose handler calls `container.get(...)`.
     * Opt out only for handlers that demonstrably don't touch DI services.
     */
    requiresInit?: boolean;
  }): void {
    // Normalize the method name for JSON-RPC compatibility
    const normalizedName = this.normalizeMethodName(command.name);

    // Convert Zod schema to JSON Schema if provided
    let inputSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
      additionalProperties: true,
    };

    if (command.parameters) {
      inputSchema = this.zodToJsonSchema(command.parameters);
    }

    // Track registered method names for debugging
    this.registeredMethodNames.push(normalizedName);

    // mt#2778: declared param names for the undeclared-key check, computed
    // once at registration. undefined (no schema / plain-object legacy schema /
    // no derivable object shape) means the check is skipped for this tool.
    const declaredParamKeys = getDeclaredParamKeys(command.parameters, normalizedName);

    // Build the tool definition — eager or lazy path.
    let toolDefinition: ToolDefinition;

    if (command.handler) {
      // Eager (legacy) path: wrap handler inline as before.
      const eagerHandler = command.handler;
      const capturedContext = this.projectContext;
      toolDefinition = {
        name: normalizedName,
        description: command.description,
        inputSchema,
        mutating: command.mutating,
        requiresInit: command.requiresInit,
        handler: async (args, progress) => {
          try {
            log.debug("Executing MCP command", {
              methodName: normalizedName,
              args: args || {},
              hasProjectContext: !!capturedContext,
            });

            // mt#2778: reject undeclared params before the handler runs.
            enforceDeclaredParams(normalizedName, args || {}, declaredParamKeys);

            const result = await eagerHandler(args || {}, capturedContext, progress);

            log.debug("MCP command executed successfully", {
              methodName: normalizedName,
              resultType: typeof result,
            });

            return result;
          } catch (error) {
            log.error("MCP command execution failed", {
              methodName: normalizedName,
              error: getErrorMessage(error),
              args: args || {},
            });
            throw error;
          }
        },
      };
    } else if (command.getHandler) {
      // mt#1792 lazy path: store a getHandler thunk that wraps the
      // CommandMapper logging + context-injection concerns around the
      // resolved handler function. The thunk is resolved once on first
      // call by the CallTool dispatch in server.ts and cached on
      // tool.handler for subsequent calls.
      const lazyGetHandler = command.getHandler;
      const capturedContext = this.projectContext;
      toolDefinition = {
        name: normalizedName,
        description: command.description,
        inputSchema,
        mutating: command.mutating,
        requiresInit: command.requiresInit,
        getHandler: async () => {
          const resolvedFn = await lazyGetHandler();
          // Return a wrapped handler that injects project context + logging,
          // matching the eager path's behaviour exactly.
          return async (args: Record<string, unknown>, progress?: ToolProgressReporter) => {
            try {
              log.debug("Executing MCP command (lazy-resolved)", {
                methodName: normalizedName,
                args: args || {},
                hasProjectContext: !!capturedContext,
              });
              // mt#2778: reject undeclared params before the handler runs.
              enforceDeclaredParams(normalizedName, args || {}, declaredParamKeys);
              const result = await resolvedFn(args || {}, capturedContext, progress);
              log.debug("MCP command executed successfully (lazy-resolved)", {
                methodName: normalizedName,
                resultType: typeof result,
              });
              return result;
            } catch (error) {
              log.error("MCP command execution failed (lazy-resolved)", {
                methodName: normalizedName,
                error: getErrorMessage(error),
                args: args || {},
              });
              throw error;
            }
          };
        },
      };
    } else {
      throw new Error(
        `addCommand: command "${command.name}" must provide either "handler" or "getHandler"`
      );
    }

    // Register the tool with the server
    this.server.addTool(toolDefinition);

    log.debug("MCP tool registered successfully", {
      methodName: normalizedName,
      description: command.description,
      hasParameters: !!command.parameters,
      isLazy: !command.handler && !!command.getHandler,
      totalRegisteredMethods: this.registeredMethodNames.length,
    });
  }

  /**
   * Get list of registered method names for debugging
   * @returns Array of registered method names
   */
  getRegisteredMethodNames(): string[] {
    return [...this.registeredMethodNames];
  }

  /**
   * Get the number of registered commands
   * @returns Number of registered commands
   */
  getRegisteredCommandCount(): number {
    return this.registeredMethodNames.length;
  }
}
