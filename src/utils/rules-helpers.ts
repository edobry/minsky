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

    // Check if file exists first to handle ENOENT gracefully
    if (!existsSync(contentPath)) {
      return contentPath;
    }

    // Try to check if it's a file and read its contents
    const stats = await fsPromises.stat(contentPath);
    if (stats.isFile()) {
      // If it's a file, read its contents
      const content = await fsPromises.readFile(contentPath, "utf-8");
      return String(content);
    } else {
      // If it exists but is not a file (e.g., directory), throw an error
      throw new Error(`Failed to read content from file ${contentPath}: Not a file`);
    }
  } catch (error) {
    // Handle missing files by returning the original path as content
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return contentPath;
    }

    // For other errors, throw a clear error message
    throw new Error(`Failed to read content from file ${contentPath}: ${error}`);
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
