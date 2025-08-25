const _COMMIT_HASH_SHORT_LENGTH = 7;

/**
 * Shared utility functions for rules operations
 */

/**
 * Helper to read content from a file if the path exists
 */
export async function readContentFromFileIfExists(contentPath: string): Promise<string> {
  try {
    // Use dynamic import to avoid module loading issues in test environment
    const fsPromises = await import("fs/promises").catch(() => null as any);
    if (!fsPromises) return contentPath;
    // Try read directly; on any error (ENOENT, EISDIR, etc.) return the input as literal content
    const content = await fsPromises.readFile(contentPath, "utf-8").catch(() => null as any);
    if (typeof content === "string") return content;
    return contentPath;
  } catch (error) {
    // On any unexpected error, return input string to avoid test env coupling
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
