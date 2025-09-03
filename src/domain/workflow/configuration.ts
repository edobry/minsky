/**
 * Workflow Configuration System
 *
 * Handles parsing and managing workflow configurations in minsky.json
 * Supports built-in tool profiles, custom commands, and tool arguments.
 */

import { z } from "zod";
import { BUILTIN_TOOLS, ToolProfile } from "./builtin-tools";

/**
 * Schema for custom workflow commands
 */
export const CustomWorkflowCommandsSchema = z.record(z.string());

/**
 * Schema for tool-based workflow configuration
 */
export const ToolWorkflowConfigSchema = z.object({
  tool: z.string(),
  args: z.string().optional(),
});

/**
 * Schema for custom workflow configuration
 */
export const CustomWorkflowConfigSchema = z.object({
  custom: CustomWorkflowCommandsSchema,
});

/**
 * Schema for simple string workflow (just tool name)
 */
export const SimpleWorkflowConfigSchema = z.string();

/**
 * Schema for any workflow configuration
 */
export const WorkflowConfigSchema = z.union([
  SimpleWorkflowConfigSchema,
  ToolWorkflowConfigSchema,
  CustomWorkflowConfigSchema,
]);

/**
 * Schema for workflows section in minsky.json
 */
export const WorkflowsConfigSchema = z.object({
  workflows: z.record(WorkflowConfigSchema).optional(),
});

/**
 * Parsed workflow configuration
 */
export interface ParsedWorkflowConfig {
  name: string;
  type: "builtin" | "custom";
  tool?: string;
  args?: string;
  commands: Record<string, string>;
  profile?: ToolProfile;
}

/**
 * Parse a workflow configuration
 */
export function parseWorkflowConfig(
  name: string,
  config: z.infer<typeof WorkflowConfigSchema>
): ParsedWorkflowConfig {
  // Simple string configuration - just tool name
  if (typeof config === "string") {
    const toolName = config;
    const profile = BUILTIN_TOOLS[toolName];

    if (profile) {
      return {
        name,
        type: "builtin",
        tool: toolName,
        commands: Object.fromEntries(
          Object.entries(profile.commands).map(([cmd, def]) => [cmd, def.command])
        ),
        profile,
      };
    }

    // Unknown tool - treat as custom
    return {
      name,
      type: "custom",
      tool: toolName,
      commands: {},
    };
  }

  // Tool with arguments
  if ("tool" in config) {
    const { tool: toolName, args } = config;
    const profile = BUILTIN_TOOLS[toolName];

    if (profile) {
      const commands = Object.fromEntries(
        Object.entries(profile.commands).map(([cmd, def]) => {
          const command = args ? `${def.command} ${args}` : def.command;
          return [cmd, command];
        })
      );

      return {
        name,
        type: "builtin",
        tool: toolName,
        args,
        commands,
        profile,
      };
    }

    // Unknown tool
    return {
      name,
      type: "custom",
      tool: toolName,
      args,
      commands: {},
    };
  }

  // Custom commands
  if ("custom" in config) {
    return {
      name,
      type: "custom",
      commands: config.custom,
    };
  }

  throw new Error(`Invalid workflow configuration for ${name}`);
}

/**
 * Parse all workflows from minsky.json
 */
export function parseWorkflowsConfig(config: Record<string, any>): ParsedWorkflowConfig[] {
  const result = WorkflowsConfigSchema.safeParse(config);

  if (!result.success) {
    return [];
  }

  const workflows = result.data.workflows || {};

  return Object.entries(workflows).map(([name, config]) => parseWorkflowConfig(name, config));
}

/**
 * Generate default workflow configuration for a project type
 */
export function generateDefaultWorkflows(
  projectType: "typescript" | "javascript" | "python"
): Record<string, any> {
  switch (projectType) {
    case "typescript":
      return {
        lint: "eslint",
        format: "prettier",
        typecheck: "tsc",
        test: {
          tool: "jest",
          args: "--bail",
        },
        security: "gitleaks",
      };

    case "javascript":
      return {
        lint: "eslint",
        format: "prettier",
        test: {
          tool: "jest",
          args: "--bail",
        },
        security: "gitleaks",
      };

    case "python":
      return {
        lint: "ruff",
        format: "black",
        typecheck: "mypy",
        test: {
          tool: "pytest",
          args: "--verbose",
        },
      };

    default:
      return {};
  }
}

/**
 * Update minsky.json with workflow configuration
 */
export function updateMinskyjsonWithWorkflows(
  existingConfig: Record<string, any>,
  workflows: Record<string, any>
): Record<string, any> {
  return {
    ...existingConfig,
    workflows: {
      ...existingConfig.workflows,
      ...workflows,
    },
  };
}
