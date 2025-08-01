/**
 * CLI Command Factory
 *
 * Factory for creating CLI commands from shared commands using the CLI bridge.
 *
 * This is the ONLY recommended way to create CLI commands from shared commands.
 * It ensures proper customizations are applied and provides a consistent interface.
 */

import { Command } from "commander";
import { CommandCategory } from "../shared/command-registry";
import {
  CliCommandBridge,
  type CliCommandOptions,
  type CategoryCommandOptions,
} from "../shared/bridges/cli-bridge";
import { log } from "../../utils/logger";

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
    enableDevWarnings: process.env.NODE_ENV !== "production",
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
    cliBridge.registerCommandCustomization(commandId!, options);
  }

  /**
   * Register customizations for a command category
   *
   * @param category - The command category to customize
   * @param options - Category customization options
   */
  customizeCategory(category: CommandCategory, options: CategoryCommandOptions): void {
    this.ensureInitialized();
    cliBridge.registerCategoryCustomization(category, options);
  }

  /**
   * Create a CLI command from a shared command
   *
   * @param commandId - The ID of the shared command
   * @returns The generated Commander.js command or null if not found
   */
  createCommand(commandId: ValidCommandId): Command | null {
    this.ensureInitialized();
    return cliBridge.generateCommand(commandId);
  }

  /**
   * Create a category command from shared commands
   *
   * @param category - The command category
   * @returns The generated category command or null if no commands found
   */
  createCategoryCommand(category: CommandCategory): Command | null {
    this.ensureInitialized();
    return cliBridge.generateCategoryCommand(category, { viaFactory: true });
  }

  /**
   * Register all commands in a program
   *
   * @param program - The Commander.js program to register commands to
   */
  registerAllCommands(program: Command): void {
    this.ensureInitialized();
    cliBridge.generateAllCategoryCommands(program, { viaFactory: true });
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
  cliFactory.customizeCommand(commandId!, options);
}

/**
 * Register customizations for a command category
 * @deprecated Use cliFactory.customizeCategory() instead
 */
export function customizeCategory(
  category: CommandCategory,
  options: CategoryCommandOptions
): void {
  cliFactory.customizeCategory(category, options);
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
export function setupCommonCommandCustomizations(_program?: Command): void {
  // Initialize the factory if not already done
  if (!cliFactory["initialized"]) {
    cliFactory.initialize();
  }

  // Task commands customization
  cliFactory.customizeCategory(CommandCategory.TASKS, {
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
          taskId: {
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
  cliFactory.customizeCategory(CommandCategory.GIT, {
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
  cliFactory.customizeCategory(CommandCategory.SESSION, {
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
            description:
              "Task ID to associate with the session (required if --description not provided)",
          },
          description: {
            alias: "d",
            description: "Description for auto-created task (required if --task not provided)",
          },
        },
        outputFormatter: (result: any) => {
          // Check if JSON output was requested
          if ((result as any).json) {
            log.cli(JSON.stringify(result as any, null, 2));
            return;
          }

          // Check if quiet mode was requested
          if ((result as any).quiet) {
            // In quiet mode, only output session directory path
            if ((result as any).session) {
              const sessionDir = `/path/to/sessions/${(result as any).session.session}`;
              log.cli(sessionDir);
            }
            return;
          }

          // Format the session start success message
          if ((result as any).success && (result as any).session) {
            // Display a user-friendly success message for session creation
            log.cli("✅ Session started successfully!");
            log.cli("");

            if ((result as any).session.session) {
              log.cli(`📁 Session: ${(result as any).session.session}`);
            }

            if ((result as any).session.taskId) {
              log.cli(`🎯 Task: ${(result as any).session.taskId}`);
            }

            if ((result as any).session.repoName) {
              log.cli(`📦 Repository: ${(result as any).session.repoName}`);
            }

            if ((result as any).session.branch) {
              log.cli(`🌿 Branch: ${(result as any).session.branch}`);
            }

            log.cli("");
            log.cli("🚀 Ready to start development!");
            log.cli("");
            log.cli("💡 Next steps:");
            log.cli("   • Your session workspace is ready for editing");
            log.cli("   • All changes will be tracked on your session branch");
            log.cli('   • Run "minsky session pr" when ready to create a pull request');
          } else {
            // Fallback to JSON output if result structure is unexpected
            log.cli(JSON.stringify(result as any, null, 2));
          }
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
      // Replaced session.pr with subcommands
      "session.pr.create": {
        useFirstRequiredParamAsArgument: false,
        parameters: {
          // === CORE PARAMETERS (Always visible) ===
          title: {
            description: "Title for the PR (auto-generated if not provided)",
          },
          body: {
            description: "Body text for the PR",
          },
          bodyPath: {
            description: "Path to file containing PR body text",
          },
          name: {
            description: "Session name (auto-detected from workspace if not provided)",
          },
          task: {
            alias: "t",
            description: "Task ID associated with the session (auto-detected if not provided)",
          },

          // === PROGRESSIVE DISCLOSURE CONTROL ===
          advanced: {
            description: "Show advanced options for conflict resolution and debugging",
          },

          // === ADVANCED PARAMETERS (Expert-level control) ===
          skipUpdate: {
            description: "Skip session update before creating PR (use with --advanced)",
          },
          noStatusUpdate: {
            description: "Skip updating task status (use with --advanced)",
          },
          debug: {
            description: "Enable debug output (use with --advanced)",
          },
          autoResolveDeleteConflicts: {
            description: "Auto-resolve delete/modify conflicts (use with --advanced)",
          },
          skipConflictCheck: {
            description: "Skip proactive conflict detection (use with --advanced)",
          },
        },
      },
      // New PR subcommands
      "session.pr.list": {
        useFirstRequiredParamAsArgument: false,
        parameters: {
          session: {
            description: "Filter PRs by specific session name",
          },
          task: {
            alias: "t",
            description: "Task ID",
          },
          status: {
            description: "Filter by PR status",
          },
          repo: {
            description: "Repository path",
          },
          json: {
            description: "Output in JSON format",
          },
          verbose: {
            description: "Show detailed PR information",
          },
        },
      },
      "session.pr.get": {
        useFirstRequiredParamAsArgument: false,
        parameters: {
          sessionName: {
            description: "Session name to look up PR for (positional)",
          },
          name: {
            description: "Session name",
          },
          task: {
            alias: "t",
            description: "Task ID",
          },
          repo: {
            description: "Repository path",
          },
          json: {
            description: "Output in JSON format",
          },
          content: {
            description: "Include PR description and diff content",
          },
        },
      },
    },
  });

  // Config commands customization
  cliFactory.customizeCategory(CommandCategory.CONFIG, {
    commandOptions: {
      "config.list": {
        outputFormatter: (result: any) => {
          // Check if JSON output was requested
          if (result.json) {
            // For JSON output, return flattened key-value pairs (matching normal output)
            const flattened = flattenObjectToKeyValue(result.resolved);
            log.cli(JSON.stringify(flattened, null, 2));
            return;
          }

          if (result.success && result.resolved) {
            let output = "";

            // Show sources if explicitly requested
            if (result.showSources && result.sources) {
              output += formatConfigurationSources(result.resolved, result.sources);
            } else {
              // For config list, show flattened key=value pairs
              output += formatFlattenedConfiguration(result.resolved);
            }

            log.cli(output);
          } else if (result.error) {
            log.cli(`Failed to load configuration: ${result.error}`);
          } else {
            log.cli(JSON.stringify(result, null, 2));
          }
        },
      },
      "config.show": {
        outputFormatter: (result: any) => {
          // Check if JSON output was requested
          if (result.json) {
            log.cli(JSON.stringify(result, null, 2));
            return;
          }

          if (result.success && result.configuration) {
            let output = "";

            // Show sources if explicitly requested
            if (result.showSources && result.sources) {
              output += formatConfigurationSources(result.configuration, result.sources);
            } else {
              // Default human-friendly structured view
              output += formatResolvedConfiguration(result.configuration);
            }

            log.cli(output);
          } else if (result.error) {
            log.cli(`Failed to load configuration: ${result.error}`);
          } else {
            log.cli(JSON.stringify(result, null, 2));
          }
        },
      },
    },
  });

  // Rules commands customization
  cliFactory.customizeCategory(CommandCategory.RULES, {
    commandOptions: {
      "rules.generate": {
        parameters: {
          interface: {
            description: "Interface preference (cli, mcp, or hybrid)",
          },
          rules: {
            description: "Comma-separated list of specific rule templates to generate",
          },
          outputDir: {
            description: "Output directory for generated rules",
          },
          dryRun: {
            alias: "n",
            description: "Show what would be generated without creating files",
          },
          overwrite: {
            description: "Overwrite existing rule files",
          },
          format: {
            description: "Rule format (cursor or openai)",
          },
          preferMcp: {
            description: "In hybrid mode, prefer MCP commands over CLI",
          },
          mcpTransport: {
            description: "MCP transport method (stdio or http)",
          },
        },
      },
      "rules.list": {
        parameters: {
          format: {
            description: "Filter by rule format (cursor or generic)",
          },
          tag: {
            description: "Filter by tag",
          },
        },
      },
      "rules.get": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          id: {
            asArgument: true,
            description: "Rule ID",
          },
          format: {
            description: "Preferred rule format (cursor or generic)",
          },
        },
      },
      "rules.create": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          id: {
            asArgument: true,
            description: "ID of the rule to create",
          },
          content: {
            description: "Rule content (can be a file path starting with @)",
          },
          description: {
            description: "Description of the rule",
          },
          name: {
            description: "Display name for the rule",
          },
          globs: {
            description: "Comma-separated list of glob patterns",
          },
          tags: {
            description: "Comma-separated list of tags",
          },
          format: {
            description: "Rule format (cursor or generic)",
          },
          overwrite: {
            description: "Overwrite existing rule if it exists",
          },
        },
      },
      "rules.update": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          id: {
            asArgument: true,
            description: "ID of the rule to update",
          },
          content: {
            description: "Updated rule content (can be a file path starting with @)",
          },
          description: {
            description: "Updated description of the rule",
          },
          name: {
            description: "Updated display name for the rule",
          },
          globs: {
            description: "Updated comma-separated list of glob patterns",
          },
          tags: {
            description: "Updated comma-separated list of tags",
          },
          format: {
            description: "Updated rule format (cursor or generic)",
          },
        },
      },
      "rules.search": {
        parameters: {
          query: {
            description: "Search query term",
          },
          tag: {
            description: "Filter by tag",
          },
          format: {
            description: "Filter by rule format (cursor or generic)",
          },
        },
      },
    },
  });

  // SessionDB commands customization
  cliFactory.customizeCategory(CommandCategory.SESSIONDB, {
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
  sources.forEach((source, index) => {
    output += `  ${index + 1}. ${source.name}\n`;
  });

  output += "\n📋 RESOLVED CONFIGURATION\n";
  output += formatResolvedConfiguration(resolved);

  output += "\n\n💡 For just the final configuration, use: minsky config show";

  return output;
}

function formatResolvedConfiguration(resolved: any): string {
  let output = "📋 CURRENT CONFIGURATION\n";

  // Task Storage
  output += `📁 Task Storage: ${getBackendDisplayName(resolved.backend)}`;
  if (resolved.backend === "github-issues" && resolved.backendConfig?.["github-issues"]) {
    const github = resolved.backendConfig["github-issues"];
    output += ` (${github.owner}/${github.repo})`;
  }
  output += "\n";

  // Authentication & Credentials
  const hasAuth =
    (resolved.credentials && Object.keys(resolved.credentials).length > 0) ||
    resolved.github?.token ||
    (resolved.ai?.providers &&
      Object.keys(resolved.ai.providers).some((p) => resolved.ai.providers[p]?.apiKey));

  if (hasAuth) {
    output += "🔐 Authentication:\n";

    // GitHub authentication
    if (resolved.github?.token || resolved.credentials?.github) {
      output += "   • GitHub: ✓ configured\n";
    }

    // AI provider authentication
    if (resolved.ai?.providers) {
      const configuredAI: string[] = [];
      for (const [provider, config] of Object.entries(resolved.ai.providers)) {
        if (config && typeof config === "object") {
          const providerConfig = config as any;
          if (providerConfig.apiKey) {
            configuredAI.push(provider);
          }
        }
      }
      if (configuredAI.length > 0) {
        output += `   • AI Providers: ${configuredAI.join(", ")} ✓\n`;
      }
    }
  }

  // Session Storage
  if (resolved.sessiondb) {
    output += "💾 Session Storage:\n";
    const sessionBackend = resolved.sessiondb.backend || "json";
    output += `   • Backend: ${getSessionBackendDisplayName(sessionBackend)}\n`;

    if (sessionBackend === "sqlite" && resolved.sessiondb.sqlite?.path) {
      output += `   • Database: ${resolved.sessiondb.sqlite.path}\n`;
    } else if (sessionBackend === "postgres" && resolved.sessiondb.postgres?.connectionString) {
      output += "   • Connection: configured\n";
    } else if (sessionBackend === "json" && resolved.sessiondb.baseDir) {
      output += `   • Directory: ${resolved.sessiondb.baseDir}\n`;
    }
  }

  // AI Configuration
  if (resolved.ai?.providers && Object.keys(resolved.ai.providers).length > 0) {
    output += "🤖 AI Configuration:\n";

    if (resolved.ai.defaultProvider) {
      output += `   • Default Provider: ${resolved.ai.defaultProvider}\n`;
    }

    output += "   • Configured Providers:\n";
    for (const [provider, config] of Object.entries(resolved.ai.providers)) {
      if (config && typeof config === "object") {
        const providerConfig = config as any;
        output += `     ${provider}:`;

        const details: string[] = [];
        if (providerConfig.model) {
          details.push(`model: ${providerConfig.model}`);
        }
        if (providerConfig.enabled !== undefined) {
          details.push(`enabled: ${providerConfig.enabled ? "yes" : "no"}`);
        }
        if (providerConfig.apiKey) {
          details.push("authenticated");
        }

        if (details.length > 0) {
          output += ` ${details.join(", ")}\n`;
        } else {
          output += "\n";
        }
      }
    }
  }

  // GitHub Configuration
  if (resolved.github && Object.keys(resolved.github).length > 0) {
    output += "🐙 GitHub Configuration:\n";

    if (resolved.github.token) {
      output += "   • Token: configured\n";
    }
    if (resolved.github.organization) {
      output += `   • Organization: ${resolved.github.organization}\n`;
    }
    if (resolved.github.baseUrl && resolved.github.baseUrl !== "https://api.github.com") {
      output += `   • Base URL: ${resolved.github.baseUrl}\n`;
    }
  }

  // Logger Configuration (show if non-default or has interesting settings)
  if (resolved.logger) {
    const logger = resolved.logger;
    const hasNonDefaultSettings =
      logger.mode !== "auto" ||
      logger.level !== "info" ||
      logger.enableAgentLogs === true ||
      logger.logFile ||
      logger.includeTimestamp === false ||
      logger.includeLevel === false;

    if (hasNonDefaultSettings) {
      output += "📊 Logger Configuration:\n";

      if (logger.mode && logger.mode !== "auto") {
        output += `   • Mode: ${logger.mode}\n`;
      }

      if (logger.level && logger.level !== "info") {
        output += `   • Level: ${logger.level}\n`;
      }

      if (logger.enableAgentLogs === true) {
        output += "   • Agent Logs: enabled\n";
      }

      if (logger.logFile) {
        output += `   • Log File: ${logger.logFile}\n`;
      }

      // Show other notable settings
      const otherSettings: string[] = [];
      if (logger.includeTimestamp === false) otherSettings.push("no timestamps");
      if (logger.includeLevel === false) otherSettings.push("no levels");
      if (logger.maxFileSize) otherSettings.push(`max file: ${logger.maxFileSize}MB`);
      if (logger.maxFiles) otherSettings.push(`max files: ${logger.maxFiles}`);

      if (otherSettings.length > 0) {
        output += `   • Other: ${otherSettings.join(", ")}\n`;
      }
    }
  }

  // Backend-specific Configuration (only show if configured)
  if (resolved.backendConfig && Object.keys(resolved.backendConfig).length > 0) {
    const hasNonEmptyBackends = Object.entries(resolved.backendConfig).some(
      ([, config]) =>
        config && typeof config === "object" && Object.keys(config as object).length > 0
    );

    if (hasNonEmptyBackends) {
      output += "⚙️  Backend Configuration:\n";

      for (const [backend, config] of Object.entries(resolved.backendConfig)) {
        if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
          output += `   • ${backend}:\n`;
          for (const [key, value] of Object.entries(config as object)) {
            output += `     ${key}: ${value}\n`;
          }
        }
      }
    }
  }

  return output.trim();
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
  if (!config || Object.keys(config).length === 0) {
    return "  (empty)";
  }

  let output = "";
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) {
      output += `  ${key}: (${value.length} items)\n`;
      value.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          output += `    ${index}: ${JSON.stringify(item)}\n`;
        } else {
          output += `    ${index}: ${item}\n`;
        }
      });
    } else if (typeof value === "object" && value !== null) {
      output += `  ${key}:\n`;
      for (const [subKey, subValue] of Object.entries(value)) {
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

  return output;
}

function sanitizeCredentials(creds: any): any {
  const sanitized = { ...creds };
  if (sanitized.token) {
    sanitized.token = `${"*".repeat(20)} (hidden)`;
  }

  return sanitized;
}

function formatFlattenedConfiguration(resolved: any): string {
  const flatten = (obj: any, prefix = ""): string[] => {
    const result: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (value === null || value === undefined) {
        result.push(`${fullKey}=(null)`);
      } else if (typeof value === "object" && !Array.isArray(value)) {
        // Recursively flatten objects
        result.push(...flatten(value, fullKey));
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          result.push(`${fullKey}=(empty array)`);
        } else {
          value.forEach((item, index) => {
            if (typeof item === "object") {
              result.push(...flatten(item, `${fullKey}[${index}]`));
            } else {
              result.push(`${fullKey}[${index}]=${item}`);
            }
          });
        }
      } else {
        result.push(`${fullKey}=${value}`);
      }
    }

    return result;
  };

  const flatEntries = flatten(resolved);
  return flatEntries.join("\n");
}

function flattenObjectToKeyValue(obj: any): any {
  const flattened: any = {};

  function flatten(current: any, prefix = ""): void {
    if (typeof current === "object" && current !== null) {
      const keys = Object.keys(current);
      for (const key of keys) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof current[key] === "object" && current[key] !== null) {
          flatten(current[key], fullKey);
        } else {
          flattened[fullKey] = current[key];
        }
      }
    }
  }

  flatten(obj);
  return flattened;
}

/**
 * Initialize the CLI command system with proper customizations
 *
 * This is the recommended way to set up the CLI system.
 */
export function initializeCliCommands(program: Command, config?: Partial<CliFactoryConfig>): void {
  // Initialize the factory
  cliFactory.initialize(config);

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
