/**
 * Shared Debug Commands
 *
 * This module contains shared debug command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandExecutionContext,
} from "../command-registry";
import { log } from "../../../utils/logger";

/**
 * Utility function to format bytes
 */
function formatBytes(bytes: number): string {
  const BYTES_PER_KB = 1024;
  if (bytes === 0) return "0 Bytes";

  const k = BYTES_PER_KB;
  const dm = 2;
  const sizes = ["Bytes", "KB", "MB", "GB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Parameters for debug.listMethods command
 */
const debugListMethodsParams = {
  // No parameters needed
};

/**
 * Parameters for debug.echo command
 */
const debugEchoParams = {
  message: {
    schema: z.string().optional(),
    description: "Message to echo back",
    required: false,
  },
  // Allow any additional properties for flexible testing
};

/**
 * Parameters for debug.systemInfo command
 */
const debugSystemInfoParams = {
  // No parameters needed
};

/**
 * Register the debug commands in the shared command registry
 */
export function registerDebugCommands(): void {
  // Register debug.listMethods command
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "debug.listMethods",
      category: CommandCategory.DEBUG,
      name: "listMethods",
      description: "List all registered methods for debugging",
      parameters: debugListMethodsParams,
      execute: async (params, context) => {
        log.debug("Executing debug.listMethods command", { params });

        // Get all commands from the registry
        const allCommands = sharedCommandRegistry.getAllCommands();
        const methodNames = allCommands.map((cmd) => cmd.id).sort();

        log.debug("Listing all registered methods", {
          count: methodNames.length,
          methods: methodNames,
        });

        return {
          methods: methodNames,
          count: methodNames.length,
          interface: context.interface || "unknown",
        };
      },
    })
  );

  // Register debug.echo command
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "debug.echo",
      category: CommandCategory.DEBUG,
      name: "echo",
      description: "Echo back the provided parameters (for testing communication)",
      parameters: debugEchoParams,
      execute: async (params, context) => {
        log.debug("Executing debug.echo command", { params });

        log.debug("Debug echo request", {
          params,
          context,
        });

        return {
          success: true,
          timestamp: new Date().toISOString(),
          echo: params,
          interface: context.interface || "unknown",
        };
      },
    })
  );

  // Register debug.systemInfo command
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "debug.systemInfo",
      category: CommandCategory.DEBUG,
      name: "systemInfo",
      description: "Get system information for diagnostics",
      parameters: debugSystemInfoParams,
      execute: async (params, context) => {
        log.debug("Executing debug.systemInfo command", { params });

        // Get basic system info for diagnostics
        const nodejsVersion = process.version;
        const platform = process.platform;
        const arch = process.arch;
        const uptime = Math.round((process as any).uptime?.() ?? 0);
        const memory = (process as any).memoryUsage?.() ?? {
          rss: 0,
          heapTotal: 0,
          heapUsed: 0,
          external: 0,
        };

        // Return formatted system information
        return {
          nodejs: {
            version: nodejsVersion,
            platform,
            arch,
            uptime,
          },
          memory: {
            rss: formatBytes(memory.rss),
            heapTotal: formatBytes(memory.heapTotal),
            heapUsed: formatBytes(memory.heapUsed),
            external: formatBytes(memory.external),
          },
          timestamp: new Date().toISOString(),
          interface: context.interface || "unknown",
        };
      },
    })
  );
}
