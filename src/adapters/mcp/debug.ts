/**
 * MCP adapter for debug commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { BYTES_PER_KB } from "../utils/constants";
import { z } from "zod";
import { log } from "../../utils/logger.js";

/**
 * Registers debug tools with the MCP command mapper
 * These tools are primarily for development and debugging purposes
 */
export function registerDebugTools(commandMapper: CommandMapper): void {
  // List all registered methods
  commandMapper.addCommand({
    name: "debug.listMethods",
    description: "List all registered MCP methods for debugging",
    _parameters: z.object({}).strict(),
    execute: async () => {
      // Get the list of all registered method names from the CommandMapper
      const methodNames = commandMapper.getRegisteredMethodNames();

      // Sort method names for easier reading
      const sortedMethods = [...methodNames].sort();

      // Log the methods for debugging
      log.debug("Listing all registered MCP methods", {
        count: sortedMethods.length,
        methods: sortedMethods,
      });

      return {
        methods: sortedMethods,
        count: sortedMethods.length,
      };
    },
  });

  // Echo command for testing JSON-RPC communication
  commandMapper.addCommand({
    name: "debug.echo",
    description: "Echo back the provided parameters (for testing MCP communication)",
    parameters: z
      .object({
        message: z.string().optional().describe("Message to echo back"),
        // Allow any additional properties for flexible testing
      })
      .passthrough(),
    execute: async (_args) => {
      // Log the echo request
      log.debug("Debug echo request", {
        _args,
      });

      // Return the provided arguments with a timestamp
      return {
        success: true,
        timestamp: new Date().toISOString(),
        echo: args,
      };
    },
  });

  // System info command for diagnostics
  commandMapper.addCommand({
    name: "debug.systemInfo",
    description: "Get system information about the MCP server",
    _parameters: z.object({}).strict(),
    execute: async () => {
      // Get basic system info for diagnostics
      const nodejsVersion = process.version;
      const platform = process.platform;
      const arch = process.arch;
      const uptime = process.uptime();
      const memory = process.memoryUsage();

      // Return formatted system information
      return {
        nodejs: {
          version: nodejsVersion,
          platform,
          arch,
          uptime: Math.round(uptime),
        },
        memory: {
          rss: formatBytes(memory.rss),
          heapTotal: formatBytes(memory.heapTotal),
          heapUsed: formatBytes(memory.heapUsed),
          external: formatBytes(memory.external),
        },
        timestamp: new Date().toISOString(),
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

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))  } ${  sizes[i]}`;
}
