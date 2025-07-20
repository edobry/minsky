/**
 * Template System for Dynamic Rule Generation
 * 
 * This module provides the foundation for converting static rule generation
 * to a dynamic, configuration-driven template system that can generate
 * CLI, MCP, or hybrid rules based on interface preferences.
 */

// ============================================================================
// Configuration Interfaces
// ============================================================================

export interface RuleGenerationConfig {
  /** Interface preference: cli, mcp, or hybrid (supports both) */
  interface: "cli" | "mcp" | "hybrid";
  
  /** Whether MCP is enabled in the project */
  mcpEnabled: boolean;
  
  /** MCP transport configuration */
  mcpTransport: "stdio" | "sse" | "httpStream";
  
  /** Whether to prefer MCP over CLI when both are available (hybrid mode) */
  preferMcp: boolean;
  
  /** Rule format for file system organization */
  ruleFormat: "cursor" | "generic";
  
  /** Optional output directory override */
  outputDir?: string;
  
  /** Optional rule selection (if not provided, generates all rules) */
  selectedRules?: string[];
}

export interface CommandMapping {
  /** CLI command pattern with parameter placeholders */
  cli: string;
  
  /** MCP tool name */
  mcp: string;
  
  /** Human-readable description of what the command does */
  description: string;
  
  /** Parameter mappings from CLI flags to MCP parameters */
  parameters?: Record<string, string>;
}

export interface TemplateContext {
  /** Current rule generation configuration */
  config: RuleGenerationConfig;
  
  /** Template helper functions */
  helpers: TemplateHelpers;
  
  /** Available command mappings */
  commands: Record<string, CommandMapping>;
}

// ============================================================================
// CLI-to-MCP Command Mappings
// ============================================================================

/**
 * Comprehensive mapping of CLI commands to MCP tool equivalents
 * This registry enables template conditionals to choose the appropriate
 * interface based on configuration.
 */
export const CLI_TO_MCP_MAPPINGS: Record<string, CommandMapping> = {
  // Task Management Commands
  "tasks.list": {
    cli: "minsky tasks list --json",
    mcp: "tasks.list",
    description: "List all tasks in the current repository",
    parameters: {
      "--json": "format: \"json\"",
      "--all": "all: true",
      "--status": "status: string"
    }
  },
  
  "tasks.get": {
    cli: "minsky tasks get #${id} --json",
    mcp: "tasks.get",
    description: "Get a task by ID",
    parameters: {
      "#${id}": "taskId: string",
      "--json": "format: \"json\""
    }
  },
  
  "tasks.status.get": {
    cli: "minsky tasks status get #${id}",
    mcp: "tasks.status.get",
    description: "Get the status of a task",
    parameters: {
      "#${id}": "taskId: string"
    }
  },
  
  "tasks.status.set": {
    cli: "minsky tasks status set #${id} ${status}",
    mcp: "tasks.status.set",
    description: "Set the status of a task",
    parameters: {
      "#${id}": "taskId: string",
      "${status}": "status: string"
    }
  },
  
  "tasks.create": {
    cli: "minsky tasks create --title \"${title}\" --description \"${description}\"",
    mcp: "tasks.create",
    description: "Create a new task",
    parameters: {
      "--title": "title: string",
      "--description": "description: string"
    }
  },
  
  "tasks.spec": {
    cli: "minsky tasks spec #${id}",
    mcp: "tasks.spec",
    description: "Get task specification content",
    parameters: {
      "#${id}": "taskId: string"
    }
  },
  
  // Session Management Commands
  "session.list": {
    cli: "minsky session list --json",
    mcp: "session.list",
    description: "List all sessions",
    parameters: {
      "--json": "format: \"json\""
    }
  },
  
  "session.get": {
    cli: "minsky session get ${name}",
    mcp: "session.get",
    description: "Get a specific session by name or task ID",
    parameters: {
      "${name}": "name: string",
      "--task": "task: string"
    }
  },
  
  "session.start": {
    cli: "minsky session start --task ${id}",
    mcp: "session.start",
    description: "Start a new session",
    parameters: {
      "--task": "task: string",
      "--description": "description: string",
      "--repo": "repo: string"
    }
  },
  
  "session.dir": {
    cli: "minsky session dir task#${id}",
    mcp: "session.dir",
    description: "Get the directory path for a session",
    parameters: {
      "task#${id}": "name: string"
    }
  },
  
  "session.delete": {
    cli: "minsky session delete ${name}",
    mcp: "session.delete",
    description: "Delete a session",
    parameters: {
      "${name}": "name: string",
      "--force": "force: boolean"
    }
  },
  
  "session.pr": {
    cli: "minsky session pr --title \"${title}\" --body-path \"${path}\"",
    mcp: "session.pr",
    description: "Create a pull request for a session",
    parameters: {
      "--title": "title: string",
      "--body-path": "bodyPath: string",
      "--body": "body: string"
    }
  },
  
  "session.approve": {
    cli: "minsky session approve ${name}",
    mcp: "session.approve",
    description: "Approve a session pull request",
    parameters: {
      "${name}": "name: string"
    }
  },
  
  "session.update": {
    cli: "minsky session update ${name}",
    mcp: "session.update",
    description: "Update a session with the latest changes",
    parameters: {
      "${name}": "name: string",
      "--force": "force: boolean"
    }
  },
  
  // Rules Management Commands
  "rules.list": {
    cli: "minsky rules list --json",
    mcp: "rules.list",
    description: "List all rules in the workspace",
    parameters: {
      "--json": "format: \"json\"",
      "--format": "format: string",
      "--tag": "tag: string"
    }
  },
  
  "rules.get": {
    cli: "minsky rules get ${id}",
    mcp: "rules.get",
    description: "Get a specific rule by ID",
    parameters: {
      "${id}": "id: string",
      "--format": "format: string"
    }
  },
  
  "rules.create": {
    cli: "minsky rules create ${id} --name \"${name}\" --description \"${description}\"",
    mcp: "rules.create",
    description: "Create a new rule",
    parameters: {
      "${id}": "id: string",
      "--name": "name: string",
      "--description": "description: string",
      "--content": "content: string"
    }
  },
  
  "rules.update": {
    cli: "minsky rules update ${id} --description \"${description}\"",
    mcp: "rules.update",
    description: "Update an existing rule",
    parameters: {
      "${id}": "id: string",
      "--description": "description: string",
      "--content": "content: string"
    }
  },
  
  "rules.search": {
    cli: "minsky rules search \"${query}\"",
    mcp: "rules.search",
    description: "Search for rules by content or metadata",
    parameters: {
      "\"${query}\"": "query: string",
      "--format": "format: string",
      "--tag": "tag: string"
    }
  },
  
  // Git Commands (Note: Most git commands are hidden from MCP, use session commands instead)
  "git.pr": {
    cli: "minsky git pr --path ${path}",
    mcp: "session.pr", // Git commands redirect to session commands in MCP
    description: "Create a pull request (use session.pr in MCP)",
    parameters: {
      "--path": "repo: string"
    }
  },
  
  "git.commit": {
    cli: "minsky git commit --message \"${message}\"",
    mcp: "git.commit", // Hidden in MCP, use session commands
    description: "Commit changes (hidden from MCP)",
    parameters: {
      "--message": "message: string",
      "--all": "all: boolean"
    }
  }
};

// ============================================================================
// Template Helper Functions  
// ============================================================================

export interface TemplateHelpers {
  /** Generate command reference based on interface preference */
  command: (commandKey: string, description?: string) => string;
  
  /** Generate code block with CLI or MCP example */
  codeBlock: (commandKey: string, example?: string) => string;
  
  /** Generate conditional content based on interface */
  conditionalSection: (content: string, interfaces: ("cli" | "mcp" | "hybrid")[]) => string;
  
  /** Generate parameter documentation */
  parameterDoc: (commandKey: string) => string;
  
  /** Generate workflow step with appropriate command */
  workflowStep: (step: string, commandKey: string, description?: string) => string;
}

/**
 * Create template helper functions for a specific configuration
 */
export function createTemplateHelpers(config: RuleGenerationConfig): TemplateHelpers {
  const shouldUseMcp = config.interface === "mcp" || 
    (config.interface === "hybrid" && config.preferMcp);
  
  return {
    command: (commandKey: string, description?: string): string => {
      const mapping = CLI_TO_MCP_MAPPINGS[commandKey];
      if (!mapping) {
        throw new Error(`Unknown command mapping: ${commandKey}`);
      }
      
      const desc = description || mapping.description;
      
      if (shouldUseMcp) {
        return `Use MCP tool \`${mapping.mcp}\` to ${desc}`;
      } else {
        return `Run \`${mapping.cli}\` to ${desc}`;
      }
    },
    
    codeBlock: (commandKey: string, example?: string): string => {
      const mapping = CLI_TO_MCP_MAPPINGS[commandKey];
      if (!mapping) {
        throw new Error(`Unknown command mapping: ${commandKey}`);
      }
      
      if (shouldUseMcp) {
        return `// Use MCP tool\n${mapping.mcp}${example ? ` ${example}` : ""}`;
      } else {
        return `# Use CLI command\n${mapping.cli}${example ? ` ${example}` : ""}`;
      }
    },
    
    conditionalSection: (content: string, interfaces: ("cli" | "mcp" | "hybrid")[]): string => {
      return interfaces.includes(config.interface) ? content : "";
    },
    
    parameterDoc: (commandKey: string): string => {
      const mapping = CLI_TO_MCP_MAPPINGS[commandKey];
      if (!mapping?.parameters) {
        return "";
      }
      
      if (shouldUseMcp) {
        const mcpParams = Object.values(mapping.parameters).join(", ");
        return `Parameters: ${mcpParams}`;
      } else {
        const cliParams = Object.keys(mapping.parameters).join(" ");
        return `Options: ${cliParams}`;
      }
    },
    
    workflowStep: (step: string, commandKey: string, description?: string): string => {
      const mapping = CLI_TO_MCP_MAPPINGS[commandKey];
      if (!mapping) {
        throw new Error(`Unknown command mapping: ${commandKey}`);
      }
      
      const desc = description || mapping.description;
      
      if (shouldUseMcp) {
        const commandRef = `Use MCP tool \`${mapping.mcp}\` to ${desc}`;
        return `${step}: ${commandRef}`;
      } else {
        const commandRef = `Run \`${mapping.cli}\` to ${desc}`;
        return `${step}: ${commandRef}`;
      }
    }
  };
}

// ============================================================================
// Template Context Creation
// ============================================================================

/**
 * Create a complete template context for rule generation
 */
export function createTemplateContext(config: RuleGenerationConfig): TemplateContext {
  return {
    config,
    helpers: createTemplateHelpers(config),
    commands: CLI_TO_MCP_MAPPINGS
  };
}

// ============================================================================
// Default Configurations
// ============================================================================

/**
 * Default configuration for CLI-first rule generation
 */
export const DEFAULT_CLI_CONFIG: RuleGenerationConfig = {
  interface: "cli",
  mcpEnabled: false,
  mcpTransport: "stdio",
  preferMcp: false,
  ruleFormat: "cursor"
};

/**
 * Default configuration for MCP-only rule generation
 */
export const DEFAULT_MCP_CONFIG: RuleGenerationConfig = {
  interface: "mcp",
  mcpEnabled: true,
  mcpTransport: "stdio",
  preferMcp: true,
  ruleFormat: "cursor"
};

/**
 * Default configuration for hybrid rule generation
 */
export const DEFAULT_HYBRID_CONFIG: RuleGenerationConfig = {
  interface: "hybrid",
  mcpEnabled: true,
  mcpTransport: "stdio",
  preferMcp: false, // Prefer CLI for familiarity
  ruleFormat: "cursor"
}; 
