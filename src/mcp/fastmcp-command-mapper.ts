/**
 * FastMCP CommandMapper - extends the base CommandMapper with FastMCP-specific methods
 */
import type { FastMCP } from "fastmcp";
import type { ProjectContext } from "../types/project";
import { z } from "zod";
import { log } from "../utils/logger";

/**
 * Extended CommandMapper that works with FastMCP server
 */
export class FastMCPCommandMapper {
  private server: FastMCP;
  private projectContext?: ProjectContext;

  constructor(server: FastMCP, projectContext?: ProjectContext) {
    this?.server = server;
    this?.projectContext = projectContext;
  }

  /**
   * Add a generic tool to the FastMCP server
   */
  addTool<T extends z.ZodTypeAny>(
    name: string,
    description: string,
    schema: T,
    handler: (args: z.infer<T>) => Promise<Record<string, any>>
  ): void {
    log.debug(`Registering tool: ${name}`, { description });

    (this.server as unknown).addTool({
      name,
      description,
      parameters: schema,
      execute: handler,
    });
  }

  /**
   * Add a session command (prefixes with "session.")
   */
  addSessionCommand<T extends z.ZodTypeAny>(
    name: string,
    description: string,
    schema: T,
    handler: (args: z.infer<T>) => Promise<Record<string, any>>
  ): void {
    this.addTool(`session.${name}`, description, schema, handler as unknown);
  }

  /**
   * Add a task command (prefixes with "tasks.")
   */
  addTaskCommand<T extends z.ZodTypeAny>(
    name: string,
    description: string,
    schema: T,
    handler: (args: z.infer<T>) => Promise<Record<string, any>>
  ): void {
    this.addTool(`tasks.${name}`, description, schema, handler as unknown);
  }

  /**
   * Add a git command (prefixes with "git.")
   */
  addGitCommand<T extends z.ZodTypeAny>(
    name: string,
    description: string,
    schema: T,
    handler: (args: z.infer<T>) => Promise<Record<string, any>>
  ): void {
    this.addTool(`git.${name}`, description, schema, handler as unknown);
  }

  /**
   * Add a simple command without prefix
   */
  addCommand(command: { name: string; description: string; inputSchema?: any }): void {
    (this.server as unknown).addTool({
      name: (command as unknown).name,
      description: (command as unknown).description,
      parameters: command?.inputSchema || z.object({}),
      execute: async () => ({ success: true }),
    });
  }

  /**
   * Get list of registered method names
   */
  getRegisteredMethodNames(): string[] {
    // This would need access to FastMCP internals
    return [];
  }

  /**
   * Get the underlying server instance
   */
  getServer(): FastMCP {
    return this.server;
  }

  /**
   * Get the project context
   */
  getProjectContext(): ProjectContext | undefined {
    return this.projectContext;
  }
}
