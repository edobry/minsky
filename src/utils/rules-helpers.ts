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
    const fsPromises = await import("fs/promises");
    const { existsSync } = await import("fs");

    // In test environment, fs functions might be undefined, so return the path as-is
    if (!existsSync || typeof existsSync !== 'function') {
      return contentPath;
    }

    // Check if file exists first to handle ENOENT gracefully
    if (!existsSync(contentPath)) {
      return contentPath;
    }

    // In test environment, readFile might be undefined too
    if (!fsPromises.readFile || typeof fsPromises.readFile !== 'function') {
      return contentPath;
    }

    // Try to read the file directly without stat check to avoid module loading issues
    try {
      const content = await fsPromises.readFile(contentPath, "utf-8");
      return String(content);
    } catch (readError) {
      // If read fails (e.g., because it's a directory), return the path
      return contentPath;
    }
  } catch (error) {
    // Handle missing files by returning the original path as content
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return contentPath;
    }

    // For other errors including module loading issues, just return the path
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
