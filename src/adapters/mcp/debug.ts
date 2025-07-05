/**
 * MCP adapter for debug commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { BYTES_PER_KB } from "../../utils/constants";
import { z } from "zod";
import { log } from "../../utils/logger.js";

/**
 * Registers debug tools with the MCP command mapper
 * These tools are primarily for development and debugging purposes
 */
export function registerDebugTools(commandMapper: CommandMapper): void {
  // List all registered methods
  (commandMapper as any).addCommand({
    name: "debug.listMethods",
    description: "List all registered MCP methods for debugging",
    parameters: (z.object({}) as any).strict(),
    execute: async () => {
      // Get the list of all registered method names from the CommandMapper
      const methodNames = (commandMapper as any).getRegisteredMethodNames();

      // Sort method names for easier reading
      const sortedMethods = ([...methodNames] as any).sort();

      // Log the methods for debugging
      log.debug("Listing all registered MCP methods", {
        count: (sortedMethods as any).length,
        methods: sortedMethods,
      });

      return {
        methods: sortedMethods,
        count: (sortedMethods as any).length,
      };
    },
  });

  // Echo command for testing JSON-RPC communication
  (commandMapper as any).addCommand({
    name: "debug.echo",
    description: "Echo back the provided parameters (for testing MCP communication)",
    parameters: (z
      .object({
        message: z.string().optional().describe("Message to echo back"),
        // Allow any additional properties for flexible testing
      }) as any).passthrough(),
    execute: async (args) => {
      // Log the echo request
      log.debug("Debug echo request", {
        args,
      });

      // Return the provided arguments with a timestamp
      return {
        success: true,
        timestamp: (new Date() as any).toISOString(),
        echo: args,
      };
    },
  });

  // System info command for diagnostics
  (commandMapper as any).addCommand({
    name: "debug.systemInfo",
    description: "Get system information about the MCP server",
    parameters: (z.object({}) as any).strict(),
    execute: async () => {
      // Get basic system info for diagnostics
      const nodejsVersion = (process as any).version;
      const platform = (process as any).platform;
      const arch = (process as any).arch;
      const uptime = (process as any).uptime();
      const memory = (process as any).memoryUsage();

      // Return formatted system information
      return {
        nodejs: {
          version: nodejsVersion,
          platform,
          arch,
          uptime: Math.round(uptime),
        },
        memory: {
          rss: formatBytes((memory as any).rss),
          heapTotal: formatBytes((memory as any).heapTotal),
          heapUsed: formatBytes((memory as any).heapUsed),
          external: formatBytes((memory as any).external),
        },
        timestamp: (new Date() as any).toISOString(),
      };
    },
  });
}

/**
 * Format bytes to a human-readable string
 * @param bytes Number of bytes
 * @returns Formatted string with appropriate unit (KB, MB, GB)
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  const k = BYTES_PER_KB;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat(((bytes / Math.pow(k, i)) as any).toFixed(2))} ${sizes[i]}`;
}
