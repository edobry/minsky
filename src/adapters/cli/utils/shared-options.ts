/**
 * Shared CLI Options
 *
 * This module provides shared option types and functions for CLI commands
 * to ensure consistent definitions, descriptions, and behavior across
 * the Minsky CLI interface.
 */

import { Command } from "commander";
import { normalizeTaskId } from "../../../domain/tasks.js";
// Removed unused schema type imports
import {
  SESSION_DESCRIPTION,
  REPO_DESCRIPTION,
  UPSTREAM_REPO_DESCRIPTION,
  JSON_DESCRIPTION,
  DEBUG_DESCRIPTION,
  TASK_ID_DESCRIPTION,
  BACKEND_DESCRIPTION,
  FORCE_DESCRIPTION,
} from "../../../utils/option-descriptions.js";

// ------------------------------------------------------------------
// Option Interfaces
// ------------------------------------------------------------------

/**
 * Repository resolution options
 * Used to identify the target repository for commands
 */
export interface RepoOptions {
  /** Session name to use for repository resolution */
  session?: string;

  /** Repository URI (overrides session) */
  repo?: string;

  /** Upstream repository URI (overrides repo and session) */
  "upstream-repo"?: string;
}

/**
 * Output format options
 * Used to control command output format
 */
export interface OutputOptions {
  /** Output result as JSON */
  json?: boolean;

  /** Enable debug output */
  debug?: boolean;
}

/**
 * Task identification options
 * Used to identify tasks for operations
 */
export interface TaskOptions {
  /** Task ID to match */
  task?: string;
}

/**
 * Backend specification options
 * Used to specify the backend for operations
 */
export interface BackendOptions {
  /** Specify backend type */
  backend?: string;
}

/**
 * Force operation options
 * Used to force operations that would otherwise fail
 */
export interface ForceOptions {
  /** Force the operation even with validation warnings or errors */
  force?: boolean;
}

// ------------------------------------------------------------------
// Option Application Functions
// ------------------------------------------------------------------

/**
 * Add repository resolution options to a command
 * @param command Commander command to add options to
 * @returns The command with options added
 */
export function addRepoOptions(command: Command): Command {
  return (command
    .option("--session <session>", SESSION_DESCRIPTION)
    .option("--repo <repositoryUri>", REPO_DESCRIPTION) as unknown).option("--upstream-repo <upstreamRepoUri>", UPSTREAM_REPO_DESCRIPTION);
}

/**
 * Add output format options to a command
 * @param command Commander command to add options to
 * @returns The command with options added
 */
export function addOutputOptions(command: Command): Command {
  return command.option("--json", JSON_DESCRIPTION).option("--debug", DEBUG_DESCRIPTION);
}

/**
 * Add task identification options to a command
 * @param command Commander command to add options to
 * @returns The command with options added
 */
export function addTaskOptions(command: Command): Command {
  return command.option("--task <taskId>", TASK_ID_DESCRIPTION);
}

/**
 * Add backend specification options to a command
 * @param command Commander command to add options to
 * @returns The command with options added
 */
export function addBackendOptions(command: Command): Command {
  return command.option("-b, --backend <backend>", BACKEND_DESCRIPTION);
}

/**
 * Add force options to a command
 * @param command Commander command to add options to
 * @returns The command with options added
 */
export function addForceOptions(command: Command): Command {
  return command.option("-f, --force", FORCE_DESCRIPTION);
}

// ------------------------------------------------------------------
// Normalization Functions
// ------------------------------------------------------------------

/**
 * Normalize repository resolution options
 *
 * @param options CLI repository options
 * @returns Normalized parameter object for domain functions
 */
export function normalizeRepoOptions(options: RepoOptions): {
  session?: string;
  repo?: string;
  workspace?: string;
} {
  return {
    session: (options as unknown).session,
    repo: (options as unknown).repo,
    workspace: (options as unknown)["upstream-repo"],
  };
}

/**
 * Normalize output format options
 *
 * @param options CLI output options
 * @returns Normalized parameter object for domain functions
 */
export function normalizeOutputOptions(options: OutputOptions): {
  json?: boolean;
  debug?: boolean;
} {
  return {
    json: (options as unknown).json,
    debug: (options as unknown).debug,
  };
}

/**
 * Normalize task identification options
 *
 * @param options CLI task options
 * @returns Normalized parameter object for domain functions
 */
export function normalizeTaskOptions(options: TaskOptions): {
  task?: string;
} {
  // If task ID is provided, normalize it
  // normalizeTaskId can return null, so handle that case
  const taskId = (options as unknown).task ? normalizeTaskId((options as unknown).task) : undefined as unknown;

  return {
    task: taskId || undefined,
  };
}

/**
 * Normalize parameter options for task commands
 *
 * @param options Combined CLI options
 * @returns Normalized parameter object for task domain functions
 */
export function normalizeTaskParams<T extends RepoOptions & OutputOptions & BackendOptions>(
  options: T
): {
  session?: string;
  repo?: string;
  workspace?: string;
  backend?: string;
  json?: boolean;
} {
  return {
    ...normalizeRepoOptions(options as unknown),
    ...normalizeOutputOptions(options as unknown),
    backend: (options as unknown).backend,
  };
}

/**
 * Normalize parameter options for session commands
 *
 * @param options Combined CLI options
 * @returns Normalized parameter object for session domain functions
 */
export function normalizeSessionParams<T extends RepoOptions & OutputOptions & TaskOptions>(
  options: T
): {
  session?: string;
  repo?: string;
  workspace?: string;
  task?: string;
  json?: boolean;
} {
  return {
    ...normalizeRepoOptions(options as unknown),
    ...normalizeOutputOptions(options as unknown),
    ...normalizeTaskOptions(options as unknown),
  };
}
