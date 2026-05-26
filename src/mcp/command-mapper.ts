import { z } from "zod";
import { log } from "@minsky/shared/logger";
import type { ProjectContext } from "../types/project";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { MinskyMCPServer, ToolDefinition } from "./server";

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
      context?: ProjectContext
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
        context?: ProjectContext
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
        handler: async (args) => {
          try {
            log.debug("Executing MCP command", {
              methodName: normalizedName,
              args: args || {},
              hasProjectContext: !!capturedContext,
            });

            const result = await eagerHandler(args || {}, capturedContext);

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
          return async (args: Record<string, unknown>) => {
            try {
              log.debug("Executing MCP command (lazy-resolved)", {
                methodName: normalizedName,
                args: args || {},
                hasProjectContext: !!capturedContext,
              });
              const result = await resolvedFn(args || {}, capturedContext);
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
