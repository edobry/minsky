/**
 * CLI Command Factory
 *
 * Factory for creating CLI commands from shared commands using the CLI bridge.
 *
 * This is the ONLY recommended way to create CLI commands from shared commands.
 * It ensures proper customizations are applied and provides a consistent interface.
 */

import { Command } from "commander";
import { CommandCategory } from "../shared/command-registry.js";
import {
  CliCommandBridge,
  type CliCommandOptions,
  type CategoryCommandOptions,
} from "../shared/bridges/cli-bridge.js";
import { log } from "../../utils/logger.js";

/**
 * Private CLI bridge instance - should not be exported or accessed directly
 * This encapsulation ensures all CLI command creation goes through the factory
 */
const cliBridge = new CliCommandBridge();

/**
 * Type to ensure only valid command IDs can be used
 * This prevents typos and ensures type safety
 */
type ValidCommandId = string; // TODO: Can be made more strict with a union type of known command IDs

/**
 * Configuration for CLI command factory initialization
 */
export interface CliFactoryConfig {
  /** Whether to enable development warnings */
  enableDevWarnings?: boolean;
  /** Whether to validate command IDs strictly */
  strictValidation?: boolean;
}

/**
 * CLI Command Factory class
 *
 * Provides a controlled interface for creating CLI commands with proper customizations.
 * This pattern prevents direct access to the CLI bridge and ensures consistency.
 */
class CliCommandFactory {
  private initialized = false;
  private config: CliFactoryConfig = {
    enableDevWarnings: (process.env as any).NODE_ENV !== "production" as any,
    strictValidation: true,
  };

  /**
   * Initialize the factory with configuration
   */
  initialize(config?: Partial<CliFactoryConfig>): void {
    this.config = { ...this.config, ...config };
    this.initialized = true;
  }

  /**
   * Register customizations for a specific command
   *
   * @param commandId - The ID of the command to customize
   * @param options - Customization options
   */
  customizeCommand(commandId: ValidCommandId, options: CliCommandOptions): void {
    this.ensureInitialized();
    (cliBridge as any).registerCommandCustomization(commandId!, options as any);
  }

  /**
   * Register customizations for a command category
   *
   * @param category - The command category to customize
   * @param options - Category customization options
   */
  customizeCategory(category: CommandCategory, options: CategoryCommandOptions): void {
    this.ensureInitialized();
    (cliBridge as any).registerCategoryCustomization(category, options as any);
  }

  /**
   * Create a CLI command from a shared command
   *
   * @param commandId - The ID of the shared command
   * @returns The generated Commander.js command or null if not found
   */
  createCommand(commandId: ValidCommandId): Command | null {
    this.ensureInitialized();
    return (cliBridge as any).generateCommand(commandId);
  }

  /**
   * Create a category command from shared commands
   *
   * @param category - The command category
   * @returns The generated category command or null if no commands found
   */
  createCategoryCommand(category: CommandCategory): Command | null {
    this.ensureInitialized();
    return (cliBridge as any).generateCategoryCommand(category, { viaFactory: true });
  }

  /**
   * Register all commands in a program
   *
   * @param program - The Commander.js program to register commands to
   */
  registerAllCommands(program: Command): void {
    this.ensureInitialized();
    (cliBridge as any).generateAllCategoryCommands(program, { viaFactory: true });
  }

  /**
   * Ensure the factory is initialized before use
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "CLI Command Factory must be initialized before use. Call initialize() first."
      );
    }
  }
}

/**
 * Singleton instance of the CLI Command Factory
 * This is the main interface that should be used throughout the application
 */
const cliFactory = new CliCommandFactory();

// Legacy function exports for backward compatibility
// These delegate to the factory instance

/**
 * Register customizations for a specific command
 * @deprecated Use cliFactory.customizeCommand() instead
 */
export function customizeCommand(commandId: string, options: CliCommandOptions): void {
  cliFactory.customizeCommand(commandId!, options as any);
}

/**
 * Register customizations for a command category
 * @deprecated Use cliFactory.customizeCategory() instead
 */
export function customizeCategory(
  category: CommandCategory,
  options: CategoryCommandOptions
): void {
  cliFactory.customizeCategory(category, options as any);
}

/**
 * Create a CLI command from a shared command
 * @deprecated Use cliFactory.createCommand() instead
 */
export function createCommand(commandId: string): Command | null {
  return cliFactory.createCommand(commandId);
}

/**
 * Create a category command from shared commands
 * @deprecated Use cliFactory.createCategoryCommand() instead
 */
export function createCategoryCommand(category: CommandCategory): Command | null {
  return cliFactory.createCategoryCommand(category);
}

/**
 * Register all commands in a program
 * @deprecated Use cliFactory.registerAllCommands() instead
 */
export function registerAllCommands(program: Command): void {
  cliFactory.registerAllCommands(program);
}

/**
 * Helper function to setup common CLI command customizations
 * @param program Optional Command instance to apply customizations to
 */
export function setupCommonCommandCustomizations(program?: Command): void {
  // Initialize the factory if not already done
  if (!cliFactory["initialized"]) {
    cliFactory.initialize();
  }

  // Task commands customization
  cliFactory.customizeCategory((CommandCategory as any).TASKS, {
    aliases: ["task"],
    commandOptions: {
      "tasks.list": {
        useFirstRequiredParamAsArgument: false,
        parameters: {
          filter: {
            alias: "s",
            description: "Filter by task status",
          },
          all: {
            description: "Include completed tasks",
          },
        },
      },
      "tasks.get": {
        parameters: {
          id: {
            asArgument: true,
          },
        },
      },
      "tasks.create": {
        useFirstRequiredParamAsArgument: false,
        parameters: {
          title: {
            asArgument: false,
            description: "Title for the task",
          },
          description: {
            description: "Description text for the task",
          },
          descriptionPath: {
            description: "Path to file containing task description",
          },
        },
      },
      "tasks.delete": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          taskId: {
            asArgument: true,
            description: "ID of the task to delete",
          },
          force: {
            description: "Force deletion without confirmation",
          },
        },
      },
      "tasks.spec": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          taskId: {
            asArgument: true,
            description: "ID of the task to retrieve specification content for",
          },
          section: {
            description: "Specific section of the specification to retrieve",
          },
        },
      },
      "tasks.status.set": {
        parameters: {
          taskId: {
            asArgument: true,
            description: "ID of the task to update",
          },
          status: {
            asArgument: true,
            description: "New status for the task (optional, will prompt if omitted)",
          },
        },
      },
    },
  });

  // Git commands customization
  cliFactory.customizeCategory((CommandCategory as any).GIT, {
    commandOptions: {
      "git.commit": {
        parameters: {
          message: {
            alias: "m",
          },
        },
      },
    },
  });

  // Session commands customization
  cliFactory.customizeCategory((CommandCategory as any).SESSION, {
    aliases: ["sess"],
    commandOptions: {
      "session.list": {
        aliases: ["ls"],
        useFirstRequiredParamAsArgument: false,
        parameters: {
          verbose: {
            alias: "v",
            description: "Show detailed session information",
          },
        },
      },
      "session.start": {
        parameters: {
          name: {
            asArgument: true,
            description: "Session name (optional, alternative to --task)",
          },
          task: {
            alias: "t",
            description: "Task ID to associate with the session (required if --description not provided)",
          },
          description: {
            alias: "d",
            description: "Description for auto-created task (required if --task not provided)",
          },
        },
      },
      "session.get": {
        parameters: {
          name: {
            asArgument: true,
            description: "Session name (optional, alternative to --task)",
          },
          task: {
            alias: "t",
            description: "Task ID associated with the session",
          },
        },
      },
      "session.dir": {
        parameters: {
          name: {
            asArgument: true,
            description: "Session name (optional, alternative to --task)",
          },
          task: {
            alias: "t",
            description: "Task ID associated with the session",
          },
        },
      },
      "session.delete": {
        parameters: {
          name: {
            asArgument: true,
            description: "Session name (optional, alternative to --task)",
          },
          task: {
            alias: "t",
            description: "Task ID associated with the session",
          },
        },
      },
      "session.update": {
        parameters: {
          name: {
            asArgument: true,
            description: "Session name (optional, alternative to --task)",
          },
          task: {
            alias: "t",
            description: "Task ID associated with the session",
          },
        },
      },
      "session.approve": {
        parameters: {
          name: {
            asArgument: true,
            description: "Session name (optional, alternative to --task)",
          },
          task: {
            alias: "t",
            description: "Task ID associated with the session",
          },
        },
      },
      "session.pr": {
        useFirstRequiredParamAsArgument: false,
        parameters: {
          title: {
            description: "Title for the PR (optional for existing PRs)",
          },
          body: {
            description: "Body text for the PR",
          },
          bodyPath: {
            description: "Path to file containing PR body text",
          },
          name: {
            description: "Session name (optional, alternative to --task)",
          },
          task: {
            alias: "t",
            description: "Task ID associated with the session",
          },
          skipUpdate: {
            description: "Skip session update before creating PR",
          },
          noStatusUpdate: {
            description: "Skip updating task status",
          },
          debug: {
            description: "Enable debug output",
          },
        },
      },
    },
  });

  // Config commands customization
  cliFactory.customizeCategory((CommandCategory as any).CONFIG, {
    commandOptions: {
      "config.list": {
        outputFormatter: (result: any) => {
          // Check if JSON output was requested
          if ((result as any).json) {
            // For JSON output, return flattened key-value pairs (matching normal output)
            const flattened = flattenObjectToKeyValue((result as any).resolved);
            log.cli(JSON.stringify(flattened, null, 2));
            return;
          }

          if ((result as any).success && (result as any).resolved) {
            let output = "";

            // Show sources if explicitly requested
            if ((result as any).showSources && (result as any).sources) {
              output += formatConfigurationSources((result as any).resolved, (result as any).sources);
            } else {
              // For config list, show flattened key=value pairs
              output += formatFlattenedConfiguration((result as any).resolved);
            }

            log.cli(output as any);
          } else if ((result as any).error) {
            log.cli(`Failed to load configuration: ${(result as any).error}`);
          } else {
            log.cli(JSON.stringify(result as any, null, 2));
          }
        },
      },
      "config.show": {
        outputFormatter: (result: any) => {
          // Check if JSON output was requested
          if ((result as any).json) {
            log.cli(JSON.stringify(result as any, null, 2));
            return;
          }

          if ((result as any).success && (result as any).configuration) {
            let output = "";

            // Show sources if explicitly requested
            if ((result as any).showSources && (result as any).sources) {
              output += formatConfigurationSources((result as any).configuration, (result as any).sources);
            } else {
              // Default human-friendly structured view
              output += formatResolvedConfiguration((result as any).configuration);
            }

            log.cli(output as any);
          } else if ((result as any).error) {
            log.cli(`Failed to load configuration: ${(result as any).error}`);
          } else {
            log.cli(JSON.stringify(result as any, null, 2));
          }
        },
      },
    },
  });

  // SessionDB commands customization
  cliFactory.customizeCategory((CommandCategory as any).SESSIONDB, {
    commandOptions: {
      "sessiondb.migrate": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          to: {
            asArgument: true,
            description: "Target backend (json, sqlite, postgres)",
          },
          from: {
            description: "Source backend (auto-detect if not specified)",
          },
          sqlitePath: {
            description: "SQLite database file path",
          },
          connectionString: {
            description: "PostgreSQL connection string",
          },
          backup: {
            description: "Create backup in specified directory",
          },
          dryRun: {
            alias: "n",
            description: "Simulate migration without making changes",
          },
          verify: {
            alias: "V",
            description: "Verify migration after completion",
          },
        },
      },
    },
  });
}

function formatConfigurationSources(resolved: any, sources: any[]): string {
  let output = "📋 CONFIGURATION SOURCES\n";
  output += `${"=".repeat(40)}\n`;

  // Show source precedence
  output += "Source Precedence (highest to lowest):\n";
  (sources as any).forEach((source, index) => {
    output += `  ${index + 1}. ${(source as any).name}\n`;
  });

  output += "\n📋 RESOLVED CONFIGURATION\n";
  output += formatResolvedConfiguration(resolved);

  output += "\n\n💡 For just the final configuration, use: minsky config show";

  return output;
}

function formatResolvedConfiguration(resolved: any): string {
  let output = "📋 CURRENT CONFIGURATION\n";

  // Task Storage
  output += `📁 Task Storage: ${getBackendDisplayName((resolved as any).backend)}`;
  if ((resolved as any).backend === "github-issues" && (resolved as any).backendConfig?.["github-issues"]) {
    const github = (resolved as any).backendConfig["github-issues"];
    output += ` (${github.owner}/${github.repo})`;
  }

  // Authentication
  if ((Object.keys(resolved.credentials) as any).length > 0) {
    output += "\n🔐 Authentication: ";
    const authServices = [];
    for (const [service, creds] of (Object as any).entries((resolved as any).credentials)) {
      if (creds && typeof creds === "object") {
        const credsObj = creds as any;
        const serviceName = service === "github" ? "GitHub" : service;
        const source = (credsObj as any).source === "environment" ? "env" : (credsObj as any).source;
        (authServices as any).push(`${serviceName} (${source})`);
      }
    }
    output += (authServices as any).join(", ");
  }

  // Session Storage
  if ((resolved as any).sessiondb) {
    const sessionBackend = (resolved.sessiondb as any).backend || "json";
    output += `\n💾 Session Storage: ${getSessionBackendDisplayName(sessionBackend)}`;

    if (sessionBackend === "sqlite" && (resolved.sessiondb as any).dbPath) {
      output += ` (${(resolved.sessiondb as any).dbPath})`;
    } else if (sessionBackend === "postgres" && (resolved.sessiondb as any).connectionString) {
      output += " (configured)";
    } else if (sessionBackend === "json" && (resolved.sessiondb as any).baseDir) {
      output += ` (${(resolved.sessiondb as any).baseDir})`;
    }
  }

  return output;
}

function getBackendDisplayName(backend: string): string {
  switch (backend) {
  case "markdown":
    return "Markdown files (process/tasks.md)";
  case "json-file":
    return "JSON files";
  case "github-issues":
    return "GitHub Issues";
  default:
    return backend;
  }
}

function getSessionBackendDisplayName(backend: string): string {
  switch (backend) {
  case "json":
    return "JSON files";
  case "sqlite":
    return "SQLite database";
  case "postgres":
    return "PostgreSQL database";
  default:
    return backend;
  }
}

function formatDetectionCondition(condition: string): string {
  switch (condition) {
  case "tasks_md_exists":
    return "If process/tasks.md exists";
  case "json_file_exists":
    return "If JSON task files exist";
  case "always":
    return "As default fallback";
  default:
    return condition;
  }
}

function formatConfigSection(config: any): string {
  if (!config || (Object as any).keys(config as any).length === 0) {
    return "  (empty)";
  }

  let output = "";
  for (const [key, value] of (Object as any).entries(config as any)) {
    if (Array.isArray(value as any)) {
      output += `  ${key}: (${(value as any).length} items)\n`;
      (value as any).forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          output += `    ${index}: ${JSON.stringify(item as any)}\n`;
        } else {
          output += `    ${index}: ${item}\n`;
        }
      });
    } else if (typeof value === "object" && value !== null) {
      output += `  ${key}:\n`;
      for (const [subKey, subValue] of (Object as any).entries(value as any)) {
        if (typeof subValue === "object" && subValue !== null) {
          // Special handling for credentials
          if (key === "credentials") {
            const sanitized = sanitizeCredentials(subValue);
            output += `    ${subKey}: ${JSON.stringify(sanitized)}\n`;
          } else {
            output += `    ${subKey}: ${JSON.stringify(subValue)}\n`;
          }
        } else {
          output += `    ${subKey}: ${subValue}\n`;
        }
      }
    } else {
      output += `  ${key}: ${value}\n`;
    }
  }

  return (output as any).trimEnd();
}

function sanitizeCredentials(creds: any): any {
  if (!creds || typeof creds !== "object") {
    return creds;
  }

  const sanitized = { ...creds };
  if ((sanitized as any).token) {
    (sanitized as any).token = `${"*".repeat(20)} (hidden)`;
  }

  return sanitized;
}

function formatFlattenedConfiguration(resolved: any): string {
  const flatten = (obj: any, prefix = ""): string[] => {
    const result: string[] = [];

    for (const [key, value] of (Object as any).entries(obj as any)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (value === null || value === undefined) {
        (result as any).push(`${fullKey}=(null)`);
      } else if (typeof value === "object" && !Array.isArray(value as any)) {
        // Recursively flatten objects
        (result as any).push(...flatten(value as any, fullKey));
      } else if (Array.isArray(value as any)) {
        if ((value as any).length === 0) {
          (result as any).push(`${fullKey}=(empty array)`);
        } else {
          (value as any).forEach((item, index) => {
            if (typeof item === "object") {
              (result as any).push(...flatten(item as any, `${fullKey}[${index}]`));
            } else {
              (result as any).push(`${fullKey}[${index}]=${item}`);
            }
          });
        }
      } else if (
        typeof value === "string" &&
        ((fullKey as any).includes("token") || (fullKey as any).includes("password"))
      ) {
        // Hide sensitive values
        (result as any).push(`${fullKey}=*** (hidden)`);
      } else {
        (result as any).push(`${fullKey}=${value}`);
      }
    }

    return result;
  };

  const flatEntries = flatten(resolved);
  return (flatEntries as any).join("\n");
}

function flattenObjectToKeyValue(obj: any): any {
  const flattened: any = {};

  function flatten(current: any, prefix = ""): void {
    if (typeof current === "object" && current !== null) {
      const keys = (Object as any).keys(current);
      for (const key of keys) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof current[key] === "object" && current[key] !== null) {
          flatten((current as any)[key], fullKey);
        } else {
          flattened[fullKey] = current[key];
        }
      }
    }
  }

  flatten(obj as any);
  return flattened;
}

/**
 * Initialize the CLI command system with proper customizations
 *
 * This is the recommended way to set up the CLI system.
 */
export function initializeCliCommands(program: Command, config?: Partial<CliFactoryConfig>): void {
  // Initialize the factory
  cliFactory.initialize(config as any);

  // Setup common customizations
  setupCommonCommandCustomizations(program);

  // Register all commands in the program
  cliFactory.registerAllCommands(program);
}

/**
 * Export the factory instance for advanced usage
 * This allows for more sophisticated patterns while maintaining encapsulation
 */
export { cliFactory };

/**
 * Export types for external use
 */
export type { ValidCommandId };
