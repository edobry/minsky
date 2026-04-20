/**
 * Shared Repo Commands
 *
 * This module contains shared repository exploration command implementations
 * that can be registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 *
 * These commands work without a session, operating on the main workspace.
 */

import { z } from "zod";
import { readFile, readdir } from "fs/promises";
import { join, resolve } from "path";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
} from "../command-registry";
import { log } from "../../../utils/logger";
import { execAsync } from "../../../utils/exec";

/**
 * Override for the workspace root — used for testing.
 * When set, resolveWorkspaceRoot() returns this value instead of process.cwd().
 */
let workspaceRootOverride: string | undefined;

/**
 * Set the workspace root override (for testing).
 */
export function setWorkspaceRootOverride(root: string | undefined): void {
  workspaceRootOverride = root;
}

/**
 * Resolve the workspace root directory.
 * Falls back to process.cwd() if no config or override is available.
 */
function resolveWorkspaceRoot(): string {
  return workspaceRootOverride ?? process.cwd();
}

/**
 * Parameters for the repo.read_file command
 */
const readFileCommandParams = {
  path: {
    schema: z.string().min(1),
    description: "File path relative to workspace root",
    required: true,
  },
  offset: {
    schema: z.number().int().positive(),
    description: "Start line (1-indexed)",
    required: false,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Number of lines to read",
    required: false,
  },
} satisfies CommandParameterMap;

/**
 * Parameters for the repo.search command
 */
const searchCommandParams = {
  pattern: {
    schema: z.string().min(1),
    description: "Search pattern (regex)",
    required: true,
  },
  path: {
    schema: z.string(),
    description: "Subdirectory to search within (relative to workspace root)",
    required: false,
  },
  ignoreCase: {
    schema: z.boolean(),
    description: "Perform case-insensitive search",
    required: false,
    defaultValue: false,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results to return",
    required: false,
    defaultValue: 50,
  },
} satisfies CommandParameterMap;

/**
 * Parameters for the repo.list_directory command
 */
const listDirectoryCommandParams = {
  path: {
    schema: z.string(),
    description: 'Directory path relative to workspace root (default: ".")',
    required: false,
    defaultValue: ".",
  },
} satisfies CommandParameterMap;

/**
 * Register the repo commands in the shared command registry
 */
export function registerRepoCommands(): void {
  // Register repo.read_file command
  sharedCommandRegistry.registerCommand({
    id: "repo.read_file",
    category: CommandCategory.REPO,
    name: "read_file",
    description: "Read a file from the workspace, optionally slicing to a line range",
    parameters: readFileCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing repo.read_file command", { params });

      const workspaceRoot = resolveWorkspaceRoot();
      const absolutePath = resolve(join(workspaceRoot, params!.path));

      // Safety check: ensure path is within workspace root
      if (!absolutePath.startsWith(workspaceRoot)) {
        return {
          success: false,
          error: "Path must be within the workspace root",
        };
      }

      try {
        const rawContent = (await readFile(absolutePath, "utf-8")) as string;
        const allLines = rawContent.split("\n");
        const totalLines = allLines.length;

        let lines: string[];
        if (params!.offset !== undefined || params!.limit !== undefined) {
          const startIndex = params!.offset !== undefined ? params!.offset - 1 : 0;
          const endIndex = params!.limit !== undefined ? startIndex + params!.limit : totalLines;
          lines = allLines.slice(startIndex, endIndex);
        } else {
          lines = allLines;
        }

        return {
          success: true,
          content: lines.join("\n"),
          totalLines,
          path: params!.path,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // Register repo.search command
  sharedCommandRegistry.registerCommand({
    id: "repo.search",
    category: CommandCategory.REPO,
    name: "search",
    description: "Search repository content using git grep",
    parameters: searchCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing repo.search command", { params });

      const workspaceRoot = resolveWorkspaceRoot();
      const pattern = params!.pattern;
      const ignoreCase = params!.ignoreCase ?? false;

      const args: string[] = ["git", "-C", workspaceRoot, "grep", "-n"];

      if (ignoreCase) {
        args.push("-i");
      }

      args.push("-e", pattern);

      if (params!.path) {
        args.push("--", params!.path);
      }

      try {
        const command = args
          .map((a) => (a.includes(" ") || a.includes("'") ? `'${a.replace(/'/g, "'\\''")}'` : a))
          .join(" ");
        const { stdout } = await execAsync(command);
        return {
          success: true,
          output: stdout.trim(),
        };
      } catch (error) {
        // git grep exits with code 1 when no matches found — treat as success with empty output
        const execError = error as { code?: number };
        if (execError.code === 1) {
          return { success: true, output: "" };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  // Register repo.list_directory command
  sharedCommandRegistry.registerCommand({
    id: "repo.list_directory",
    category: CommandCategory.REPO,
    name: "list_directory",
    description: "List directory contents in the workspace",
    parameters: listDirectoryCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing repo.list_directory command", { params });

      const workspaceRoot = resolveWorkspaceRoot();
      const relativePath = params!.path ?? ".";
      const absolutePath = resolve(join(workspaceRoot, relativePath));

      // Safety check: ensure path is within workspace root
      if (!absolutePath.startsWith(workspaceRoot)) {
        return {
          success: false,
          error: "Path must be within the workspace root",
        };
      }

      try {
        const entries = await readdir(absolutePath, { withFileTypes: true });
        const result = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }));

        return {
          success: true,
          entries: result,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
