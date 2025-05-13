import { FastMCP } from "fastmcp";
import { z } from "zod";

/**
 * The CommandMapper class provides utilities for mapping Minsky CLI commands
 * to MCP tools using FastMCP.
 */
export class CommandMapper {
  private server: FastMCP;

  /**
   * Create a new CommandMapper
   * @param server The FastMCP server instance
   */
  constructor(server: FastMCP) {
    this.server = server;
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
          const result = await command.execute(args);
          // If result is a string, return it directly
          if (typeof result === "string") {
            return result;
          }
          // Otherwise, return it as a JSON string for structured data
          return JSON.stringify(result, null, 2);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Error executing command ${command.name}:`, errorMessage);
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
    this.addCommand({
      name: `tasks.${name}`,
      description,
      parameters,
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
    this.addCommand({
      name: `session.${name}`,
      description,
      parameters,
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
    this.addCommand({
      name: `git.${name}`,
      description,
      parameters,
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
    this.addCommand({
      name: `rules.${name}`,
      description,
      parameters,
      execute: executeFunction,
    });
  }
}
