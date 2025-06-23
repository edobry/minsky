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
export function registerInitTools(_commandMapper: CommandMapper): void {
  // Register the init command
  commandMapper.addCommand({
    name: "init",
    description: "Initialize a project for Minsky",
    params: z.object({
      _repoPath: z.string().optional().describe("Repository path (defaults to current directory)"),
      backend: z.enum(["tasks.md", "tasks.csv"]).optional().describe("Task backend type"),
      ruleFormat: z.enum(["cursor", "generic"]).optional().describe("Rule format"),
      mcp: z
        .object({
          enabled: z.boolean().optional().describe("Enable MCP configuration"),
          transport: z
            .enum(["stdio", "sse", "httpStream"])
            .optional()
            .describe("MCP transport type"),
          port: z.number().optional().describe("Port for MCP network transports"),
          host: z.string().optional().describe("Host for MCP network transports"),
        })
        .optional()
        .describe("MCP configuration _options"),
      mcpOnly: z
        .boolean()
        .optional()
        .describe("Only configure MCP, skip other initialization steps"),
      overwrite: z.boolean().optional().describe("Overwrite existing files"),
    }),
    execute: async (params) => {
      // Set default values
      const initParams = {
        repoPath: params.repoPath || process.cwd(),
        backend: params.backend || "tasks.md",
        ruleFormat: params.ruleFormat || "cursor",
        mcp: params.mcp,
        mcpOnly: params.mcpOnly || false,
        overwrite: params.overwrite || false,
      };

      // Call the domain function
      await initializeProjectFromParams(initParams);

      // Return success message
      return {
        success: true,
        message: "Project initialized for Minsky",
        config: {
          repoPath: initParams.repoPath,
          backend: initParams.backend,
          ruleFormat: initParams.ruleFormat,
          mcp: initParams.mcp,
        },
      };
    },
  });
}
