/**
 * Shared Command MCP Integration Example
 * 
 * This file demonstrates how to integrate the shared command system
 * with the MCP adapter. It can be used as a reference for future
 * migration of other commands.
 */

import { CommandSchema } from "@minsky/core";
import { registerGitCommands } from "../shared/commands/git.js";
import { CommandCategory } from "../shared/command-registry.js";
import { log } from "../../utils/logger.js";

// Mock import for demonstration purposes
// In a real implementation, this would be imported from the MCP adapter bridge
const mcpBridge = {
  registerSharedCommands: (categories: CommandCategory[]) => {
    log.debug(`Registering MCP commands for categories: ${categories.join(", ")}`);
    // Implementation would:
    // 1. Get commands from shared registry for the specified categories
    // 2. Create MCP command schemas from them
    // 3. Register with MCP server
  }
};

/**
 * Sample MCP command schema for git commit
 */
const gitCommitCommandSchema: CommandSchema<any, any> = {
  name: "git.commit",
  description: "Commit changes to the repository",
  parameters: {
    message: {
      type: "string",
      description: "Commit message",
      required: true,
    },
    all: {
      type: "boolean",
      description: "Stage all changes including deletions",
      required: false,
    },
    repo: {
      type: "string",
      description: "Repository path",
      required: false,
    },
    session: {
      type: "string",
      description: "Session identifier",
      required: false,
    },
  },
  // In real implementation, this would call the shared command registry
  handler: async (params) => {
    log.debug("MCP git.commit called with params:", params);
    return {
      success: true,
      commitHash: "example-hash",
      message: params.message,
    };
  },
};

/**
 * Demonstrates how to integrate shared commands with MCP
 * 
 * This is an example of how the Minsky MCP server could be updated
 * to use the shared command registry.
 */
export function setupMcpWithSharedCommands(): void {
  log.debug("Setting up MCP with shared commands");
  
  // Register git commands in the shared registry
  registerGitCommands();
  
  // Bridge the commands to MCP
  mcpBridge.registerSharedCommands([CommandCategory.GIT]);
  
  log.debug("MCP setup complete with shared commands");
}

// Export for use in tests
export { gitCommitCommandSchema }; 
