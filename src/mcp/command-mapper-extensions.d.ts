/**
 * Type extensions for CommandMapper to support FastMCP tool registration
 */
import type { z } from "zod";
import type { CommandMapper } from "./command-mapper.js";

declare module "./command-mapper.js" {
  interface CommandMapper {
    /**
     * Add a tool to the MCP server
     */
    addTool<T extends z.ZodTypeAny>(
      name: string,
      description: string,
      schema: T,
      handler: (args: z.infer<T>) => Promise<Record<string, unknown>>
    ): void;

    /**
     * Add a session command to the MCP server
     */
    addSessionCommand<T extends z.ZodTypeAny>(
      name: string,
      description: string,
      schema: T,
      handler: (args: z.infer<T>) => Promise<Record<string, unknown>>
    ): void;

    /**
     * Add a task command to the MCP server
     */
    addTaskCommand<T extends z.ZodTypeAny>(
      name: string,
      description: string,
      schema: T,
      handler: (args: z.infer<T>) => Promise<Record<string, unknown>>
    ): void;

    /**
     * Add a git command to the MCP server
     */
    addGitCommand<T extends z.ZodTypeAny>(
      name: string,
      description: string,
      schema: T,
      handler: (args: z.infer<T>) => Promise<Record<string, unknown>>
    ): void;

    /**
     * Get the list of registered method names
     */
    getRegisteredMethodNames(): string[];
  }
}
