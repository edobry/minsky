/**
 * Command Generator
 *
 * This module provides utilities for dynamically generating CLI and MCP command
 * syntax from the shared command registry, ensuring consistent representation
 * across different interfaces.
 */

import { sharedCommandRegistry, CommandCategory, type SharedCommand, type CommandParameterMap } from "../../adapters/shared/command-registry";

/**
 * Interface mode for command generation
 */
export type InterfaceMode = "cli" | "mcp" | "hybrid";

/**
 * Command parameter representation
 */
export interface CommandParameter {
  name: string;
  description?: string;
  required: boolean;
  defaultValue?: any;
  cliOption?: string;
  mcpName?: string;
}

/**
 * Command representation with parameter information
 */
export interface CommandRepresentation {
  id: string;
  category: CommandCategory;
  description: string;
  cliSyntax: string;
  mcpSyntax: string;
  parameters: CommandParameter[];
}

/**
 * Configuration for command generation
 */
export interface CommandGenerationConfig {
  /** Which interface to target */
  interfaceMode: InterfaceMode;
  /** Whether MCP is enabled */
  mcpEnabled: boolean;
  /** Whether to prefer MCP over CLI when in hybrid mode */
  preferMcp: boolean;
}

/**
 * Generates the CLI syntax for a command
 */
function generateCliSyntax(commandId: string, parameters: CommandParameter[]): string {
  const baseCommand = `minsky ${commandId.replace(".", " ")}`;
  
  // Add required arguments
  const requiredArgs = parameters
    .filter(param => param.required)
    .map(param => `<${param.name}>`)
    .join(" ");

  // Add optional arguments
  const optionalArgs = parameters
    .filter(param => !param.required)
    .map(param => {
      if (typeof param.defaultValue === "boolean") {
        return `[--${param.name}]`;
      }
      return `[--${param.name} <value>]`;
    })
    .join(" ");

  const args = [requiredArgs, optionalArgs].filter(Boolean).join(" ");
  return args ? `${baseCommand} ${args}` : baseCommand;
}

/**
 * Generates the MCP syntax for a command
 */
function generateMcpSyntax(commandId: string, parameters: CommandParameter[]): string {
  const mcpCommand = commandId; // MCP uses dot notation as-is
  
  // Build parameter object
  const paramEntries = parameters.map(param => {
    const name = param.mcpName || param.name;
    if (param.required) {
      return `"${name}": <value>`;
    } else {
      return `"${name}": <optional value>`;
    }
  });
  
  const paramString = paramEntries.length > 0 
    ? `{\n    ${paramEntries.join(",\n    ")}\n  }`
    : "{}";
  
  return `mcp_minsky_server_${mcpCommand}(${paramString})`;
}

/**
 * Gets parameter information for a command
 */
function getCommandParameters(command: SharedCommand): CommandParameter[] {
  if (!command.parameters) {
    return [];
  }

  return Object.entries(command.parameters).map(([name, paramDef]) => ({
    name,
    description: paramDef.description,
    required: paramDef.required,
    defaultValue: paramDef.defaultValue,
    cliOption: `--${name}`,
    mcpName: name
  }));
}

/**
 * Gets a full representation of a command with all syntax variants
 */
export function getCommandRepresentation(commandId: string): CommandRepresentation | null {
  const command = sharedCommandRegistry.getCommand(commandId);
  if (!command) {
    return null;
  }
  
  const parameters = getCommandParameters(command);
  
  return {
    id: commandId,
    category: command.category,
    description: command.description,
    cliSyntax: generateCliSyntax(commandId, parameters),
    mcpSyntax: generateMcpSyntax(commandId, parameters),
    parameters
  };
}

/**
 * Gets the appropriate command syntax based on the interface mode
 */
export function getCommandSyntax(
  commandId: string, 
  config: CommandGenerationConfig
): string | null {
  const representation = getCommandRepresentation(commandId);
  if (!representation) {
    return null;
  }
  
  switch (config.interfaceMode) {
    case "cli":
      return representation.cliSyntax;
    case "mcp":
      return representation.mcpSyntax;
    case "hybrid":
      return config.preferMcp ? representation.mcpSyntax : representation.cliSyntax;
    default:
      return representation.cliSyntax;
  }
}

/**
 * Gets all commands in a specific category
 */
export function getCommandsByCategory(category: CommandCategory): CommandRepresentation[] {
  const commands = sharedCommandRegistry.getCommandsByCategory(category);
  return commands.map(cmd => {
    const parameters = getCommandParameters(cmd);
    return {
      id: cmd.id,
      category: cmd.category,
      description: cmd.description,
      cliSyntax: generateCliSyntax(cmd.id, parameters),
      mcpSyntax: generateMcpSyntax(cmd.id, parameters),
      parameters
    };
  });
}

/**
 * Gets parameter documentation for a command
 */
export function getParameterDocumentation(commandId: string): string {
  const representation = getCommandRepresentation(commandId);
  if (!representation || representation.parameters.length === 0) {
    return "No parameters available for this command.";
  }
  
  const paramDocs = representation.parameters.map(param => {
    const requiredText = param.required ? "Required" : "Optional";
    const defaultText = param.defaultValue !== undefined 
      ? `Default: \`${param.defaultValue}\`` 
      : "";
    
    return `- \`${param.name}\`: ${param.description || "No description"} (${requiredText}${defaultText ? `, ${defaultText}` : ""})`;
  });
  
  return paramDocs.join("\n");
}

/**
 * Service for generating commands based on the current configuration
 */
export class CommandGeneratorService {
  private config: CommandGenerationConfig;
  
  constructor(config: CommandGenerationConfig) {
    this.config = config;
  }
  
  /**
   * Gets the appropriate command syntax for the current configuration
   */
  getCommandSyntax(commandId: string): string | null {
    return getCommandSyntax(commandId, this.config);
  }
  
  /**
   * Gets commands in a category for the current configuration
   */
  getCommandsByCategory(category: CommandCategory): Array<{
    id: string;
    description: string;
    syntax: string;
  }> {
    const commands = getCommandsByCategory(category);
    return commands.map(cmd => ({
      id: cmd.id,
      description: cmd.description,
      syntax: this.getCommandSyntax(cmd.id) || ""
    }));
  }
  
  /**
   * Gets parameter documentation for a command
   */
  getParameterDocumentation(commandId: string): string {
    return getParameterDocumentation(commandId);
  }
  
  /**
   * Updates the current configuration
   */
  updateConfig(config: Partial<CommandGenerationConfig>): void {
    this.config = {
      ...this.config,
      ...config
    };
  }
}

/**
 * Creates a command generator service with the specified configuration
 */
export function createCommandGeneratorService(config: CommandGenerationConfig): CommandGeneratorService {
  return new CommandGeneratorService(config);
} 
