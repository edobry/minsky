import { z } from "zod";
import { log } from "../utils/logger";
import type { ProjectContext } from "../types/project";
import { getErrorMessage } from "../errors/index";
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
   * Normalize method name to ensure compatibility with MCP
   *
   * The MCP protocol supports dots in method names for namespacing,
   * but some JSON-RPC implementations may have issues with dot notation.
   * We normalize method names and provide underscore aliases for compatibility.
   *
   * @param methodName Original method name (may contain dots for namespacing)
   * @returns Normalized method name safe for JSON-RPC
   */
  private normalizeMethodName(methodName: string): string {
    // Remove any characters that could cause issues in JSON-RPC
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
   */
  addCommand(command: {
    name: string;
    description: string;
    parameters?: z.ZodType;
    handler: (
      args: Record<string, unknown>,
      context?: ProjectContext
    ) => Promise<string | Record<string, unknown>>;
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

    // Create the tool definition
    const toolDefinition: ToolDefinition = {
      name: normalizedName,
      description: command.description,
      inputSchema,
      handler: async (args) => {
        try {
          log.debug("Executing MCP command", {
            methodName: normalizedName,
            args: args || {},
            hasProjectContext: !!this.projectContext,
          });

          // Pass the project context to the handler if available
          const result = await command.handler(args || {}, this.projectContext);

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

          // Re-throw to let the MCP server handle error presentation
          throw error;
        }
      },
    };

    // Register the tool with the server
    this.server.addTool(toolDefinition);

    log.debug("MCP tool registered successfully", {
      methodName: normalizedName,
      description: command.description,
      hasParameters: !!command.parameters,
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
