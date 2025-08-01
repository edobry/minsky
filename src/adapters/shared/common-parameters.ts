/**
 * Common Parameter Definitions for Shared Commands
 *
 * This module provides reusable parameter definitions to eliminate duplication
 * across all shared command implementations. These parameters follow consistent
 * patterns and can be composed into command-specific parameter maps.
 */

import { z } from "zod";
import { type CommandParameterDefinition } from "./command-registry";

/**
 * Core common parameters used across multiple command categories
 */
export const CommonParameters = {
  /**
   * Repository path parameter
   */
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  } as CommandParameterDefinition,

  /**
   * JSON output format parameter
   */
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * Debug output parameter
   */
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * Session identifier parameter
   */
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Task identifier parameter
   */
  task: {
    schema: z.string(),
    description: "Task identifier",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Workspace path parameter
   */
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Force operation parameter
   */
  force: {
    schema: z.boolean(),
    description: "Force the operation",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * Quiet/suppress output parameter
   */
  quiet: {
    schema: z.boolean(),
    description: "Suppress output",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * Backend type parameter
   */
  backend: {
    schema: z.string(),
    description: "Backend type",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Overwrite confirmation parameter
   */
  overwrite: {
    schema: z.boolean(),
    description: "Overwrite existing resources",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,
} as const;

/**
 * Git-specific common parameters
 */
export const GitParameters = {
  /**
   * Git branch parameter
   */
  branch: {
    schema: z.string(),
    description: "Git branch name",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Git remote parameter
   */
  remote: {
    schema: z.string(),
    description: "Git remote name",
    required: false,
    defaultValue: "origin",
  } as CommandParameterDefinition,

  /**
   * No status update parameter
   */
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * No stash parameter
   */
  noStash: {
    schema: z.boolean(),
    description: "Skip stashing changes",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * No push parameter
   */
  noPush: {
    schema: z.boolean(),
    description: "Skip pushing changes",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * Auto-resolve conflicts parameter
   */
  autoResolve: {
    schema: z.boolean(),
    description: "Enable automatic conflict resolution",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * Preview conflicts parameter
   */
  preview: {
    schema: z.boolean(),
    description: "Preview potential conflicts",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,
} as const;

/**
 * Session-specific common parameters
 */
export const SessionParameters = {
  /**
   * Session name parameter
   */
  name: {
    schema: z.string(),
    description: "Session name",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Session name (with minimum length requirement)
   */
  sessionName: {
    schema: z.string().min(1),
    description: "Session identifier (name or task ID)",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Skip installation parameter
   */
  skipInstall: {
    schema: z.boolean(),
    description: "Skip automatic dependency installation",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * Package manager parameter
   */
  packageManager: {
    schema: z.enum(["bun", "npm", "yarn", "pnpm"]),
    description: "Package manager to use",
    required: false,
  } as CommandParameterDefinition,
} as const;

/**
 * Task-specific common parameters
 */
export const TaskParameters = {
  /**
   * Task ID parameter (required)
   */
  taskId: {
    schema: z.string(),
    description: "Task identifier",
    required: true,
  } as CommandParameterDefinition,

  /**
   * Task ID parameter (optional)
   */
  taskIdOptional: {
    schema: z.string(),
    description: "Task identifier",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Task title parameter
   */
  title: {
    schema: z.string().min(1),
    description: "Task title",
    required: true,
  } as CommandParameterDefinition,

  /**
   * Task description parameter
   */
  description: {
    schema: z.string(),
    description: "Task description",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Task status parameter
   */
  status: {
    schema: z.enum(["TODO", "IN-PROGRESS", "IN-REVIEW", "DONE", "BLOCKED", "CLOSED"]),
    description: "Task status",
    required: false,
  } as CommandParameterDefinition,

  /**
   * All tasks parameter
   */
  all: {
    schema: z.boolean(),
    description: "Include all tasks regardless of status",
    required: false,
    defaultValue: false,
  } as CommandParameterDefinition,

  /**
   * Task limit parameter
   */
  limit: {
    schema: z.number(),
    description: "Maximum number of tasks to return",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Task filter parameter
   */
  filter: {
    schema: z.string(),
    description: "Filter criteria for tasks",
    required: false,
  } as CommandParameterDefinition,
} as const;

/**
 * Rules-specific common parameters
 */
export const RulesParameters = {
  /**
   * Rule ID parameter (required)
   */
  id: {
    schema: z.string().min(1),
    description: "Rule ID",
    required: true,
  } as CommandParameterDefinition,

  /**
   * Rule content parameter
   */
  content: {
    schema: z.string(),
    description: "Rule content (markdown or text)",
    required: true,
  } as CommandParameterDefinition,

  /**
   * Rule format parameter
   */
  format: {
    schema: z.string().optional(),
    description: "Rule format (cursor or generic)",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Rule tags parameter
   */
  tag: {
    schema: z.string(),
    description: "Rule tag for filtering",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Rule tags parameter (multiple)
   */
  tags: {
    schema: z.string().optional(),
    description: "Comma-separated rule tags",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Rule search query parameter
   */
  query: {
    schema: z.string(),
    description: "Search query for rules",
    required: false,
  } as CommandParameterDefinition,

  /**
   * Rule globs parameter
   */
  globs: {
    schema: z.string().optional(),
    description: "Comma-separated list or JSON array of glob patterns",
    required: false,
  } as CommandParameterDefinition,
} as const;

/**
 * Config-specific common parameters
 */
export const ConfigParameters = {
  /**
   * Configuration sources parameter
   */
  sources: {
    schema: z.boolean().default(false),
    description: "Show configuration sources and precedence",
    required: false,
  } as CommandParameterDefinition,
} as const;

/**
 * Utility functions for composing parameter maps
 */

/**
 * Create a parameter map with common base parameters
 */
export function withCommonParams<T extends Record<string, CommandParameterDefinition>>(
  params: T
): T & typeof CommonParameters {
  return { ...CommonParameters, ...params };
}

/**
 * Create a parameter map with git-specific parameters
 */
export function withGitParams<T extends Record<string, CommandParameterDefinition>>(
  params: T
): T & typeof GitParameters {
  return { ...GitParameters, ...params };
}

/**
 * Create a parameter map with session-specific parameters
 */
export function withSessionParams<T extends Record<string, CommandParameterDefinition>>(
  params: T
): T & typeof SessionParameters {
  return { ...SessionParameters, ...params };
}

/**
 * Create a parameter map with task-specific parameters
 */
export function withTaskParams<T extends Record<string, CommandParameterDefinition>>(
  params: T
): T & typeof TaskParameters {
  return { ...TaskParameters, ...params };
}

/**
 * Create a parameter map with rules-specific parameters
 */
export function withRulesParams<T extends Record<string, CommandParameterDefinition>>(
  params: T
): T & typeof RulesParameters {
  return { ...RulesParameters, ...params };
}

/**
 * Helper for creating parameter maps with multiple composed parameter sets
 */
export function composeParams<
  A extends Record<string, CommandParameterDefinition>,
  B extends Record<string, CommandParameterDefinition>,
>(a: A, b: B): A & B {
  return { ...a, ...b };
}
