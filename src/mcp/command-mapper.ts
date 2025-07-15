import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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
   * Get the current project context
   * @returns The current project context, or undefined if not available
   */
  getProjectContext(): ProjectContext | undefined {
    return this.projectContext;
  }

  /**
   * Get a list of all registered method names
   * @returns Array of method names that have been registered
   */
  getRegisteredMethodNames(): string[] {
    return [...this.registeredMethodNames];
  }

  /**
   * Normalize method name to ensure compatibility with MCP
   *
   * This handles potential issues in the JSON-RPC method naming conventions
   * by normalizing the method name to a format the MCP protocol can process.
   *
   * @param methodName Original method name
   * @returns Normalized method name
   */
  private normalizeMethodName(methodName: string): string {
    // Ensure there are no unexpected characters in the method name
    // Replace any problematic characters with underscores
    const normalized = methodName.replace(/[^a-zA-Z0-9_.]/g, "_");

    // Log the normalization if it changed the method name
    if (normalized !== methodName) {
      log.debug("Normalized method name for compatibility", {
        original: methodName,
        normalized,
      });
    }

    return normalized;
  }

  /**
   * Convert Zod schema to JSON Schema for MCP compatibility
   * @param zodSchema The Zod schema to convert
   * @returns JSON Schema object
   */
  private zodToJsonSchema(zodSchema: z.ZodTypeAny): any {
    try {
      return zodToJsonSchema(zodSchema, {
        name: "ToolParameters",
        $refStrategy: "none", // Inline all definitions
      });
    } catch (error) {
      log.warn("Failed to convert Zod schema to JSON Schema, using fallback", {
        error: getErrorMessage(error as any),
      });
      
      // Fallback to a basic object schema
      return {
        type: "object",
        properties: {},
        additionalProperties: true,
      };
    }
  }

  /**
   * Add a basic command to the server
   * @param command Command definition with name, parameters, description, and execution logic
   */
  addCommand<T extends z.ZodTypeAny>(command: {
    name: string;
    description: string;
    parameters?: T;
    execute: (args: z.infer<T>) => Promise<string | Record<string, any>>;
  }): void {
    // Normalize the method name for consistency and compatibility
    const normalizedName = this.normalizeMethodName(command.name);

    // Convert Zod schema to JSON Schema
    const inputSchema = command.parameters 
      ? this.zodToJsonSchema(command.parameters)
      : { type: "object", properties: {}, additionalProperties: false };

    // Log the addition of the tool to help with debugging
    log.debug("Registering MCP tool", {
      methodName: normalizedName,
      originalName: command.name,
      description: command.description,
      hasParameters: command.parameters ? true : false,
    });

    // Keep track of registered method names
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
            args,
          });

          // Validate args against Zod schema if provided
          let validatedArgs = args;
          if (command.parameters) {
            try {
              validatedArgs = command.parameters.parse(args);
            } catch (validationError) {
              const errorMessage = getErrorMessage(validationError as any);
              log.error("Command parameter validation failed", {
                command: normalizedName,
                error: errorMessage,
                args,
              });
              throw new Error(`Invalid parameters for command '${normalizedName}': ${errorMessage}`);
            }
          }

          // If the command might use repository context and no explicit repository is provided,
          // inject the default repository path from project context
          if (
            this.projectContext &&
            this.projectContext.repositoryPath &&
            validatedArgs &&
            typeof validatedArgs === "object"
          ) {
            if (!("repositoryPath" in validatedArgs) || !validatedArgs.repositoryPath) {
              validatedArgs = {
                ...validatedArgs,
                repositoryPath: this.projectContext.repositoryPath,
              };
            }
          }

          const result = await command.execute(validatedArgs);
          
          // Return result directly - the server will handle formatting
          return result;
        } catch (error) {
          const errorMessage = getErrorMessage(error as any);
          log.error("Error executing MCP command", {
            command: normalizedName,
            error: errorMessage,
            args,
            stack: error instanceof Error ? (error as any).stack : undefined,
          });
          
          // Re-throw to let the MCP server handle error presentation
          throw error;
        }
      },
    };

    // Register the tool with the server
    this.server.addTool(toolDefinition);

    // Also register underscore alias for dot notation compatibility
    // This provides a fallback for JSON-RPC clients that have issues with dot notation
    if (normalizedName.includes(".")) {
      const underscoreName = normalizedName.replace(/\./g, "_");

      // Don't register the same name twice
      if (underscoreName !== normalizedName) {
        log.debug("Also registering underscore alias for dot notation", {
          originalName: normalizedName,
          underscoreName,
        });

        // Keep track of the alias
        this.registeredMethodNames.push(underscoreName);

        // Create alias tool definition
        const aliasToolDefinition: ToolDefinition = {
          name: underscoreName,
          description: `${command.description} (underscore alias)`,
          inputSchema,
          handler: toolDefinition.handler, // Same handler
        };

        // Register the alias
        this.server.addTool(aliasToolDefinition);
      }
    }
  }

  /**
   * Add a task command to the server
   * @param name Command name
   * @param description Command description
   * @param parameters Command parameters schema
   * @param executeFunction Function to execute the command
   */
  addTaskCommand<T extends z.ZodObject<any>>(
    name: string,
    description: string,
    parameters: T,
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, any>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape).includes("repositoryPath");

    let extendedParameters: z.ZodTypeAny;
    if (!hasRepositoryPath) {
      // Create extended parameters including repositoryPath
      extendedParameters = parameters.extend({
        repositoryPath: z
          .string()
          .optional()
          .describe("Repository path to use for this operation (overrides server context)"),
      });
    } else {
      extendedParameters = parameters;
    }

    this.addCommand({
      name: `tasks.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction as (
        args: z.infer<typeof extendedParameters>
      ) => Promise<string | Record<string, any>>,
    });
  }

  /**
   * Add a session command to the server
   * @param name Command name
   * @param description Command description
   * @param parameters Command parameters schema
   * @param executeFunction Function to execute the command
   */
  addSessionCommand<T extends z.ZodObject<any>>(
    name: string,
    description: string,
    parameters: T,
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, any>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape).includes("repositoryPath");

    let extendedParameters: z.ZodTypeAny;
    if (!hasRepositoryPath) {
      extendedParameters = parameters.extend({
        repositoryPath: z
          .string()
          .optional()
          .describe("Repository path to use for this operation (overrides server context)"),
      });
    } else {
      extendedParameters = parameters;
    }

    this.addCommand({
      name: `session.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction as (
        args: z.infer<typeof extendedParameters>
      ) => Promise<string | Record<string, any>>,
    });
  }

  /**
   * Add a git command to the server
   * @param name Command name
   * @param description Command description
   * @param parameters Command parameters schema
   * @param executeFunction Function to execute the command
   */
  addGitCommand<T extends z.ZodObject<any>>(
    name: string,
    description: string,
    parameters: T,
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, any>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape).includes("repositoryPath");

    let extendedParameters: z.ZodTypeAny;
    if (!hasRepositoryPath) {
      extendedParameters = parameters.extend({
        repositoryPath: z
          .string()
          .optional()
          .describe("Repository path to use for this operation (overrides server context)"),
      });
    } else {
      extendedParameters = parameters;
    }

    this.addCommand({
      name: `git.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction as (
        args: z.infer<typeof extendedParameters>
      ) => Promise<string | Record<string, any>>,
    });
  }

  /**
   * Add a rule command to the server
   * @param name Command name
   * @param description Command description
   * @param parameters Command parameters schema
   * @param executeFunction Function to execute the command
   */
  addRuleCommand<T extends z.ZodObject<any>>(
    name: string,
    description: string,
    parameters: T,
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, any>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape).includes("repositoryPath");

    let extendedParameters: z.ZodTypeAny;
    if (!hasRepositoryPath) {
      extendedParameters = parameters.extend({
        repositoryPath: z
          .string()
          .optional()
          .describe("Repository path to use for this operation (overrides server context)"),
      });
    } else {
      extendedParameters = parameters;
    }

    this.addCommand({
      name: `rules.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction as (
        args: z.infer<typeof extendedParameters>
      ) => Promise<string | Record<string, any>>,
    });
  }
}
