/**
 * Shared Repo Commands
 *
 * This module contains shared repository exploration commands that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 *
 * These commands operate on the workspace root (non-session-scoped).
 */

import { z } from "zod";
import { readFile, readdir } from "fs/promises";
import { resolve } from "path";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
} from "../command-registry";
import { execAsync } from "../../../utils/exec";

// Workspace root override for testing
let workspaceRootOverride: string | null = null;

/**
 * Set a workspace root override for testing purposes.
 */
export function setWorkspaceRootOverride(root: string | null): void {
  workspaceRootOverride = root;
}

/**
 * Resolve the workspace root: returns override if set, otherwise process.cwd().
 */
export function resolveWorkspaceRoot(): string {
  return workspaceRootOverride ?? process.cwd();
}

/**
 * Parameters for repo.read_file
 */
const readFileCommandParams = {
  path: {
    schema: z.string().min(1),
    description: "File path relative to workspace root",
    required: true,
  },
  offset: {
    schema: z.number().int().nonnegative(),
    description: "Line offset to start reading from (0-based)",
    required: false,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of lines to return",
    required: false,
  },
} satisfies CommandParameterMap;

/**
 * Parameters for repo.search
 */
const searchCommandParams = {
  pattern: {
    schema: z.string().min(1),
    description: "Search pattern (regex)",
    required: true,
  },
  path: {
    schema: z.string(),
    description: "Restrict search to this path (relative to workspace root)",
    required: false,
  },
  ignoreCase: {
    schema: z.boolean(),
    description: "Perform case-insensitive search",
    required: false,
    defaultValue: false,
  },
} satisfies CommandParameterMap;

/**
 * Parameters for repo.list_directory
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
    description: "Read a file from the workspace, with optional line range slicing",
    parameters: readFileCommandParams,
    requiresSetup: false,
    execute: async (params, _context) => {
      const workspaceRoot = resolveWorkspaceRoot();
      const filePath = params.path as string;

      // Path traversal safety check
      const absolutePath = resolve(workspaceRoot, filePath);
      if (!absolutePath.startsWith(workspaceRoot)) {
        throw new Error(`Path traversal detected: ${filePath}`);
      }

      let content: string;
      try {
        content = (await readFile(absolutePath, "utf-8")) as string;
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          path: filePath,
        };
      }

      const lines = content.split("\n");
      const totalLines = lines.length;

      const offset = (params.offset as number | undefined) ?? 0;
      const limit = params.limit as number | undefined;

      let slicedLines: string[];
      if (offset > 0 || limit !== undefined) {
        const end = limit !== undefined ? offset + limit : undefined;
        slicedLines = lines.slice(offset, end);
      } else {
        slicedLines = lines;
      }

      return {
        success: true,
        content: slicedLines.join("\n"),
        totalLines,
        path: filePath,
      };
    },
  });

  // Register repo.search command
  sharedCommandRegistry.registerCommand({
    id: "repo.search",
    category: CommandCategory.REPO,
    name: "search",
    description: "Search repository content using git grep",
    parameters: searchCommandParams,
    requiresSetup: false,
    execute: async (params, _context) => {
      const workspaceRoot = resolveWorkspaceRoot();
      const pattern = params.pattern as string;
      const ignoreCase = (params.ignoreCase as boolean | undefined) ?? false;
      const searchPath = params.path as string | undefined;

      const args: string[] = ["git", "-C", workspaceRoot, "grep", "-n", "-e"];

      // Quote pattern if it contains spaces
      if (pattern.includes(" ")) {
        args.push(`'${pattern.replace(/'/g, "'\\''")}'`);
      } else {
        args.push(pattern);
      }

      if (ignoreCase) {
        args.push("-i");
      }

      if (searchPath) {
        args.push("--", searchPath);
      }

      try {
        const { stdout } = await execAsync(args.join(" "));
        return {
          success: true,
          output: stdout.trim(),
        };
      } catch (error) {
        // git grep exits with code 1 when no matches found — treat as success with empty output
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code: unknown }).code === 1
        ) {
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
    description: "List files and directories in a workspace directory",
    parameters: listDirectoryCommandParams,
    requiresSetup: false,
    execute: async (params, _context) => {
      const workspaceRoot = resolveWorkspaceRoot();
      const dirPath = (params.path as string | undefined) ?? ".";

      // Path traversal safety check
      const absolutePath = resolve(workspaceRoot, dirPath);
      if (!absolutePath.startsWith(workspaceRoot)) {
        throw new Error(`Path traversal detected: ${dirPath}`);
      }

      let entries: { name: string; type: "file" | "directory" }[];
      try {
        const dirEntries = await readdir(absolutePath, { withFileTypes: true });
        entries = dirEntries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }));
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      return {
        success: true,
        entries,
      };
    },
  });
}
