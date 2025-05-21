import { FastMCP } from "fastmcp";
import { z } from "zod";
import { log } from "../utils/logger.js";
import type { ProjectContext } from "../types/project.js";

/**
 * The CommandMapper class provides utilities for mapping Minsky CLI commands
 * to MCP tools using FastMCP.
 */
export class CommandMapper {
  private server: FastMCP;
  private projectContext: ProjectContext | undefined;

  /**
   * Create a new CommandMapper
   * @param server The FastMCP server instance
   * @param projectContext Optional project context containing repository information
   */
  constructor(server: FastMCP, projectContext?: ProjectContext) {
    this.server = server;
    this.projectContext = projectContext;
    
    if (projectContext) {
      log.debug("CommandMapper initialized with project context", {
        repositoryPath: projectContext.repositoryPath
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
   * Add a basic command to the server
   * @param command Command definition with name, parameters, description, and execution logic
   */
  addCommand<T extends z.ZodTypeAny>(command: {
    name: string;
    description: string;
    parameters?: T;
    execute: (args: z.infer<T>) => Promise<string | Record<string, unknown>>;
  }): void {
    this.server.addTool({
      name: command.name,
      description: command.description,
      parameters: command.parameters || z.object({}),
      execute: async (args) => {
        try {
          // If the command might use repository context and no explicit repository is provided,
          // inject the default repository path from project context
          if (this.projectContext && this.projectContext.repositoryPath && args && typeof args === 'object') {
            if (!('repositoryPath' in args) || !args.repositoryPath) {
              args = {
                ...args,
                repositoryPath: this.projectContext.repositoryPath
              };
              log.debug(`Using default repository path for command ${command.name}`, {
                repositoryPath: this.projectContext.repositoryPath
              });
            }
          }
          
          const result = await command.execute(args);
          // If result is a string, return it directly
          if (typeof result === "string") {
            return result;
          }
          // Otherwise, return it as a JSON string for structured data
          return JSON.stringify(result, null, 2);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error("Error executing MCP command", {
            command: command.name,
            error: errorMessage,
            args,
            stack: error instanceof Error ? error.stack : undefined
          });
          throw error; // Re-throw to let FastMCP handle error presentation
        }
      },
    });
  }

  /**
   * Add a task command to the server
   * @param name Command name
   * @param description Command description
   * @param parameters Command parameters schema
   * @param executeFunction Function to execute the command
   */
  addTaskCommand<T extends z.ZodTypeAny>(
    name: string,
    description: string,
    parameters: T,
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, unknown>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape || {}).includes('repositoryPath');
    
    let extendedParameters: z.ZodTypeAny = parameters;
    if (!hasRepositoryPath) {
      // Using type assertion since we're dynamically extending the schema
      extendedParameters = parameters.extend({
        repositoryPath: z.string().optional().describe("Repository path to use for this operation (overrides server context)"),
      }) as z.ZodTypeAny;
    }
    
    this.addCommand({
      name: `tasks.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction,
    });
  }

  /**
   * Add a session command to the server
   * @param name Command name
   * @param description Command description
   * @param parameters Command parameters schema
   * @param executeFunction Function to execute the command
   */
  addSessionCommand<T extends z.ZodTypeAny>(
    name: string,
    description: string,
    parameters: T,
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, unknown>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape || {}).includes('repositoryPath');
    
    let extendedParameters: z.ZodTypeAny = parameters;
    if (!hasRepositoryPath) {
      // Using type assertion since we're dynamically extending the schema
      extendedParameters = parameters.extend({
        repositoryPath: z.string().optional().describe("Repository path to use for this operation (overrides server context)"),
      }) as z.ZodTypeAny;
    }
    
    this.addCommand({
      name: `session.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction,
    });
  }

  /**
   * Add a git command to the server
   * @param name Command name
   * @param description Command description
   * @param parameters Command parameters schema
   * @param executeFunction Function to execute the command
   */
  addGitCommand<T extends z.ZodTypeAny>(
    name: string,
    description: string,
    parameters: T,
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, unknown>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape || {}).includes('repositoryPath');
    
    let extendedParameters: z.ZodTypeAny = parameters;
    if (!hasRepositoryPath) {
      // Using type assertion since we're dynamically extending the schema
      extendedParameters = parameters.extend({
        repositoryPath: z.string().optional().describe("Repository path to use for this operation (overrides server context)"),
      }) as z.ZodTypeAny;
    }
    
    this.addCommand({
      name: `git.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction,
    });
  }

  /**
   * Add a rule command to the server
   * @param name Command name
   * @param description Command description
   * @param parameters Command parameters schema
   * @param executeFunction Function to execute the command
   */
  addRuleCommand<T extends z.ZodTypeAny>(
    name: string,
    description: string,
    parameters: T,
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, unknown>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape || {}).includes('repositoryPath');
    
    let extendedParameters: z.ZodTypeAny = parameters;
    if (!hasRepositoryPath) {
      // Using type assertion since we're dynamically extending the schema
      extendedParameters = parameters.extend({
        repositoryPath: z.string().optional().describe("Repository path to use for this operation (overrides server context)"),
      }) as z.ZodTypeAny;
    }
    
    this.addCommand({
      name: `rules.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction,
    });
  }
}
