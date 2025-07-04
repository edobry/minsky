/**
 * MCP adapter for init commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";

// Import domain functions
import { initializeProjectFromParams } from "../../domain/index.js";

/**
 * Registers initialization tools with the MCP command mapper
 */
export function registerInitTools(commandMapper: CommandMapper): void {
  // Register the init command
  (commandMapper as any).addCommand({
    name: "init",
    description: "Initialize a project for Minsky",
    parameters: z.object({
      _repoPath: z.string().optional().describe("Repository path (defaults to current directory)"),
      backend: z.enum(["tasks.md", "tasks.csv"] as any[]).optional().describe("Task backend type"),
      ruleFormat: z.enum(["cursor", "generic"] as any[]).optional().describe("Rule format"),
      mcp: z
        .object({
          enabled: (z.boolean().optional() as any).describe("Enable MCP configuration"),
          transport: z
            .enum(["stdio", "sse", "httpStream"] as any[])
            .optional()
            .describe("MCP transport type"),
          port: (z.number().optional() as any).describe("Port for MCP network transports"),
          host: z.string().optional().describe("Host for MCP network transports"),
        })
        .optional()
        .describe("MCP configuration _options"),
      mcpOnly: (z
        .boolean()
        .optional() as any).describe("Only configure MCP, skip other initialization steps"),
      overwrite: (z.boolean().optional() as any).describe("Overwrite existing files"),
    }),
    execute: async (params) => {
      // Set default values
      const initParams = {
        repoPath: (params as any).repoPath || (process as any).cwd(),
        backend: (params as any).backend || "tasks.md",
        ruleFormat: (params as any).ruleFormat || "cursor",
        mcp: (params as any).mcp,
        mcpOnly: (params as any).mcpOnly || false,
        overwrite: (params as any).overwrite || false,
      } as any;

      // Call the domain function
      await initializeProjectFromParams(initParams);

      // Return success message
      return {
        success: true,
        message: "Project initialized for Minsky",
        config: {
          repoPath: (initParams as any).repoPath,
          backend: initParams.backend,
          ruleFormat: initParams.ruleFormat,
          mcp: initParams.mcp,
        },
      };
    },
  });
}
