/**
 * Shared Command MCP Integration Example
 * 
 * This file demonstrates how to integrate the shared command system
 * with the MCP adapter. It can be used as a reference for future
 * migration of other commands.
 */

// Define local type for CommandSchema since @minsky/core isn't available in this context
interface CommandSchema<Params, Result> {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required: boolean;
  }>;
  handler: (params: Params) => Promise<Result>;
}

import { registerGitCommands } from "../shared/commands/git.js";
import { registerTasksCommands } from "../shared/commands/tasks.js";
import { registerSessionCommands } from "../shared/commands/session.js";
import { registerRulesCommands } from "../shared/commands/rules.js";
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
  handler: async (params: any) => {
    log.debug("MCP git.commit called with params:", params);
    return {
      success: true,
      commitHash: "example-hash",
      message: params.message,
    };
  },
};

/**
 * Sample MCP command schema for tasks status get
 */
const tasksStatusGetCommandSchema: CommandSchema<any, any> = {
  name: "tasks.status.get",
  description: "Get the status of a task",
  parameters: {
    taskId: {
      type: "string",
      description: "Task ID",
      required: true,
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
  handler: async (params: any) => {
    log.debug("MCP tasks.status.get called with params:", params);
    return {
      success: true,
      taskId: params.taskId,
      status: "TODO", // Example status
    };
  },
};

/**
 * Sample MCP command schema for session list
 */
const sessionListCommandSchema: CommandSchema<any, any> = {
  name: "session.list",
  description: "List all sessions",
  parameters: {
    repo: {
      type: "string",
      description: "Repository path",
      required: false,
    },
  },
  // In real implementation, this would call the shared command registry
  handler: async (params: any) => {
    log.debug("MCP session.list called with params:", params);
    return {
      success: true,
      sessions: [
        {
          session: "example-session-1",
          repoName: "example-repo",
          taskId: "123",
          branch: "feature-123"
        },
        {
          session: "example-session-2",
          repoName: "example-repo",
          taskId: "456",
          branch: "feature-456"
        }
      ]
    };
  },
};

/**
 * Sample MCP command schema for rules list
 */
const rulesListCommandSchema: CommandSchema<any, any> = {
  name: "rules.list",
  description: "List all rules in the workspace",
  parameters: {
    format: {
      type: "string",
      description: "Filter by rule format (cursor or generic)",
      required: false,
    },
    tag: {
      type: "string",
      description: "Filter by tag",
      required: false,
    },
  },
  // In real implementation, this would call the shared command registry
  handler: async (params: any) => {
    log.debug("MCP rules.list called with params:", params);
    return {
      success: true,
      rules: [
        {
          id: "example-rule-1",
          name: "Example Rule 1",
          description: "Description for example rule 1",
          format: "cursor",
          globs: ["*.ts"],
          tags: ["typescript"]
        },
        {
          id: "example-rule-2",
          name: "Example Rule 2",
          description: "Description for example rule 2",
          format: "generic",
          globs: ["*.md"],
          tags: ["docs"]
        }
      ]
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
  
  // Register shared commands in the registry
  registerGitCommands();
  registerTasksCommands();
  registerSessionCommands();
  registerRulesCommands();
  
  // Bridge the commands to MCP
  mcpBridge.registerSharedCommands([
    CommandCategory.GIT, 
    CommandCategory.TASKS,
    CommandCategory.SESSION,
    CommandCategory.RULES
  ]);
  
  log.debug("MCP setup complete with shared commands");
}

// Export for use in tests
export { 
  gitCommitCommandSchema,
  tasksStatusGetCommandSchema,
  sessionListCommandSchema,
  rulesListCommandSchema
}; 
