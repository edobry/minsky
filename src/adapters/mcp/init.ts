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
  commandMapper.addCommand({
    name: "init",
    description: "Initialize a project for Minsky",
    parameters: z.object({
      repoPath: z.string().optional(),
      backend: z.string().optional(),
      ruleFormat: z.string().optional(),
      mcp: z
        .object({
          enabled: z.boolean().optional(),
          port: z.number().optional(),
          host: z.string().optional(),
        })
        .optional(),
      mcpOnly: z.boolean().optional(),
      overwrite: z.boolean().optional(),
    }),
    execute: async (params: any) => {
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
