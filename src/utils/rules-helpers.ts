const _COMMIT_HASH_SHORT_LENGTH = 7;

/**
 * Shared utility functions for rules operations
 */

import type { promises as fsPromises } from "fs";
import fs from "fs";

/**
 * File system dependencies for rules helpers
 */
export interface RulesHelpersDependencies {
  fsPromises?: Pick<typeof fsPromises, "readFile" | "stat">;
  existsSyncFn?: (path: string) => boolean;
}

/**
 * Helper to read content from a file if the path exists
 * Uses dependency injection for proper testability
 */
export async function readContentFromFileIfExists(
  contentPath: string,
  deps?: RulesHelpersDependencies
): Promise<string> {
  // Defensive check: ensure contentPath is defined
  if (!contentPath || typeof contentPath !== "string") {
    return contentPath || "";
  }

  // Use injected dependencies or defaults
  const fsOps = deps?.fsPromises || (await import("fs/promises"));
  const existsSync = deps?.existsSyncFn || fs.existsSync;

  try {
    // Check if file exists first to handle ENOENT gracefully
    if (!existsSync(contentPath)) {
      return contentPath;
    }

    // Try to check if it's a file and read its contents
    const stats = await fsOps.stat(contentPath);
    if (stats.isFile()) {
      // If it's a file, read its contents
      const content = await fsOps.readFile(contentPath, "utf-8");
      return String(content);
    } else {
      // If it exists but is not a file (e.g., directory), return the path
      return contentPath;
    }
  } catch (error) {
    // Handle missing files by returning the original path as content
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return contentPath;
    }

    // For other errors, also return the path as fallback
    return contentPath;
  }
}

/**
 * Parse glob patterns from a string, handling both comma-separated values and JSON arrays
 */
export function parseGlobs(globsStr?: string): string[] | undefined {
  if (!globsStr || globsStr.trim() === "") {
    return undefined;
  }

  // Try to parse as JSON array first
  try {
    const parsed = JSON.parse(globsStr);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    // If JSON parsing fails, fall back to comma-separated string
  }

  // Handle as comma-separated string
  return globsStr.split(",").map((glob) => glob.trim());
}
