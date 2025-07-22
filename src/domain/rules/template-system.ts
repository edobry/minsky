/**
 * Template System for Dynamic Rule Generation
 *
 * This module provides utilities for dynamically generating rules based on configuration.
 * It enables creating rules that adapt to CLI, MCP, or hybrid interfaces.
 */

import {
  CommandGeneratorService,
  type InterfaceMode,
  createCommandGeneratorService
} from "./command-generator";
import { CommandCategory } from "../../adapters/shared/command-registry";

/**
 * Configuration for rule generation
 */
export interface RuleGenerationConfig {
  /** Interface preference (cli, mcp, or hybrid) */
  interface: InterfaceMode;
  /** Whether MCP is enabled */
  mcpEnabled: boolean;
  /** Transport for MCP (stdio, http) - only used when mcpEnabled is true */
  mcpTransport: "stdio" | "http";
  /** Whether to prefer MCP in hybrid mode */
  preferMcp: boolean;
  /** Rule format (cursor or openai) */
  ruleFormat: "cursor" | "openai";
  /** Output directory for generated files */
  outputDir: string;
}

/**
 * Helper functions for template content generation
 */
export interface TemplateHelpers {
  /**
   * Generates command syntax based on the current configuration
   * @param commandId Shared command ID
   * @param description Optional description for documentation
   */
  command: (commandId: string, description?: string) => string;

  /**
   * Wraps content in a code block with specified language
   * @param content Code content
   * @param language Code language
   */
  codeBlock: (content: string, language: string) => string;

  /**
   * Creates a conditional section that only renders if a condition is met
   * @param condition Condition to evaluate
   * @param content Content to include if condition is true
   * @param fallback Optional content to include if condition is false
   */
  conditionalSection: (condition: boolean, content: string, fallback?: string) => string;

  /**
   * Generates parameter documentation for a command
   * @param commandId Shared command ID
   */
  parameterDoc: (commandId: string) => string;

  /**
   * Creates a workflow step with proper command formatting
   * @param commandId Shared command ID
   * @param description Description of the step
   */
  workflowStep: (commandId: string, description: string) => string;
}

/**
 * Context object for templates
 */
export interface TemplateContext {
  /** Configuration for rule generation */
  config: RuleGenerationConfig;
  /** Helper functions for template content generation */
  helpers: TemplateHelpers;
  /** Command generator service */
  commandGenerator: CommandGeneratorService;
}

/**
 * Creates template helpers based on configuration
 */
function createTemplateHelpers(config: RuleGenerationConfig, commandGenerator: CommandGeneratorService): TemplateHelpers {
  // Flag for interface preference
  const shouldUseMcp = config.interface === "mcp" || (config.interface === "hybrid" && config.preferMcp);

  return {
    command: (commandId: string, description?: string) => {
      const syntax = commandGenerator.getCommandSyntax(commandId);
      if (!syntax) {
        throw new Error(`Command not found: ${commandId}`);
      }

      if (description) {
        return `${syntax} - ${description}`;
      }
      return syntax;
    },

    codeBlock: (content: string, language: string = "bash") => {
      return "```" + language + "\n" + content + "\n```";
    },

    conditionalSection: (condition: boolean, content: string, fallback?: string) => {
      if (condition) {
        return content;
      }
      return fallback || "";
    },

    parameterDoc: (commandId: string) => {
      return commandGenerator.getParameterDocumentation(commandId);
    },

    workflowStep: (commandId: string, description: string) => {
      const syntax = commandGenerator.getCommandSyntax(commandId);
      if (!syntax) {
        throw new Error(`Command not found: ${commandId}`);
      }

      return `1. **${description}**\n   ${syntax}`;
    }
  };
}

/**
 * Creates a template context object
 */
export function createTemplateContext(config: RuleGenerationConfig): TemplateContext {
  // Create a command generator with the current config
  const commandGenerator = createCommandGeneratorService({
    interfaceMode: config.interface,
    mcpEnabled: config.mcpEnabled,
    preferMcp: config.preferMcp
  });

  // Create helpers based on the command generator
  const helpers = createTemplateHelpers(config, commandGenerator);

  return {
    config,
    helpers,
    commandGenerator
  };
}

/**
 * Default CLI configuration
 */
export const DEFAULT_CLI_CONFIG: RuleGenerationConfig = {
  interface: "cli",
  mcpEnabled: false,
  mcpTransport: "stdio",
  preferMcp: false,
  ruleFormat: "cursor",
  outputDir: ".cursor/rules"
};

/**
 * Default MCP configuration
 */
export const DEFAULT_MCP_CONFIG: RuleGenerationConfig = {
  interface: "mcp",
  mcpEnabled: true,
  mcpTransport: "stdio",
  preferMcp: true,
  ruleFormat: "cursor",
  outputDir: ".cursor/rules"
};

/**
 * Default hybrid configuration
 */
export const DEFAULT_HYBRID_CONFIG: RuleGenerationConfig = {
  interface: "hybrid",
  mcpEnabled: true,
  mcpTransport: "stdio",
  preferMcp: false, // Default to CLI for familiarity
  ruleFormat: "cursor",
  outputDir: ".cursor/rules"
}; 
