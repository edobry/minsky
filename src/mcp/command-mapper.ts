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
  private registeredMethodNames: string[] = [];

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
   * Get a list of all registered method names
   * @returns Array of method names that have been registered
   */
  getRegisteredMethodNames(): string[] {
    return [...this.registeredMethodNames];
  }

  /**
   * Normalize method name to ensure compatibility with FastMCP
   * 
   * This handles potential issues in the JSON-RPC method naming conventions
   * by normalizing the method name to a format FastMCP can reliably process.
   * 
   * @param methodName Original method name
   * @returns Normalized method name
   */
  private normalizeMethodName(methodName: string): string {
    // Ensure there are no unexpected characters in the method name
    // Replace any problematic characters with underscores
    const normalized = methodName.replace(/[^a-zA-Z0-9_.]/g, '_');
    
    // Log the normalization if it changed the method name
    if (normalized !== methodName) {
      log.debug(`Normalized method name for compatibility`, {
        original: methodName,
        normalized
      });
    }
    
    return normalized;
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
    // Normalize the method name for consistency and compatibility
    const normalizedName = this.normalizeMethodName(command.name);
    
    // Log the addition of the tool to help with debugging
    log.debug(`Registering MCP tool`, {
      methodName: normalizedName,
      originalName: command.name,
      description: command.description,
      hasParameters: command.parameters ? true : false
    });
    
    // Keep track of registered method names
    this.registeredMethodNames.push(normalizedName);
    
    // Register the tool with FastMCP
    this.server.addTool({
      name: normalizedName,
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
              log.debug(`Using default repository path for command ${normalizedName}`, {
                repositoryPath: this.projectContext.repositoryPath
              });
            }
          }
          
          // Log that we're executing the command (helpful for debugging)
          log.debug(`Executing MCP command`, {
            methodName: normalizedName,
            args
          });
          
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
            command: normalizedName,
            error: errorMessage,
            args,
            stack: error instanceof Error ? error.stack : undefined
          });
          throw error; // Re-throw to let FastMCP handle error presentation
        }
      },
    });
    
    // Also register the method with an underscore-based name if it contains dots
    // This provides a fallback for JSON-RPC clients that have issues with dot notation
    if (normalizedName.includes('.')) {
      const underscoreName = normalizedName.replace(/\./g, '_');
      
      // Don't register the same name twice
      if (underscoreName !== normalizedName) {
        log.debug(`Also registering underscore alias for dot notation`, {
          originalName: normalizedName,
          underscoreName
        });
        
        // Keep track of the alias
        this.registeredMethodNames.push(underscoreName);
        
        // Register the alias
        this.server.addTool({
          name: underscoreName,
          description: `${command.description} (underscore alias)`,
          parameters: command.parameters || z.object({}),
          execute: async (args) => {
            try {
              log.debug(`Executing MCP command via underscore alias`, {
                methodName: underscoreName,
                originalName: normalizedName,
                args
              });
              
              // If the command might use repository context and no explicit repository is provided,
              // inject the default repository path from project context
              if (this.projectContext && this.projectContext.repositoryPath && args && typeof args === 'object') {
                if (!('repositoryPath' in args) || !args.repositoryPath) {
                  args = {
                    ...args,
                    repositoryPath: this.projectContext.repositoryPath
                  };
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
              log.error("Error executing MCP command via underscore alias", {
                command: underscoreName,
                originalName: normalizedName,
                error: errorMessage,
                args,
                stack: error instanceof Error ? error.stack : undefined
              });
              throw error; // Re-throw to let FastMCP handle error presentation
            }
          },
        });
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
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, unknown>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape).includes('repositoryPath');
    
    let extendedParameters: z.ZodTypeAny;
    if (!hasRepositoryPath) {
      // Create extended parameters including repositoryPath
      extendedParameters = parameters.extend({
        repositoryPath: z.string().optional().describe("Repository path to use for this operation (overrides server context)"),
      });
    } else {
      extendedParameters = parameters;
    }
    
    this.addCommand({
      name: `tasks.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction as (args: z.infer<typeof extendedParameters>) => Promise<string | Record<string, unknown>>,
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
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, unknown>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape).includes('repositoryPath');
    
    let extendedParameters: z.ZodTypeAny;
    if (!hasRepositoryPath) {
      extendedParameters = parameters.extend({
        repositoryPath: z.string().optional().describe("Repository path to use for this operation (overrides server context)"),
      });
    } else {
      extendedParameters = parameters;
    }
    
    this.addCommand({
      name: `session.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction as (args: z.infer<typeof extendedParameters>) => Promise<string | Record<string, unknown>>,
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
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, unknown>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape).includes('repositoryPath');
    
    let extendedParameters: z.ZodTypeAny;
    if (!hasRepositoryPath) {
      extendedParameters = parameters.extend({
        repositoryPath: z.string().optional().describe("Repository path to use for this operation (overrides server context)"),
      });
    } else {
      extendedParameters = parameters;
    }
    
    this.addCommand({
      name: `git.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction as (args: z.infer<typeof extendedParameters>) => Promise<string | Record<string, unknown>>,
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
    executeFunction: (args: z.infer<T>) => Promise<string | Record<string, unknown>>
  ): void {
    // Extend parameters to include optional repositoryPath if not already present
    const hasRepositoryPath = Object.keys(parameters.shape).includes('repositoryPath');
    
    let extendedParameters: z.ZodTypeAny;
    if (!hasRepositoryPath) {
      extendedParameters = parameters.extend({
        repositoryPath: z.string().optional().describe("Repository path to use for this operation (overrides server context)"),
      });
    } else {
      extendedParameters = parameters;
    }
    
    this.addCommand({
      name: `rules.${name}`,
      description,
      parameters: extendedParameters,
      execute: executeFunction as (args: z.infer<typeof extendedParameters>) => Promise<string | Record<string, unknown>>,
    });
  }
}
