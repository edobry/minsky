/**
 * Glob matching utilities for rule file patterns
 *
 * Implements glob pattern matching compatible with Cursor's rule system
 */

/**
 * Parse the globs field from a rule's frontmatter
 * Supports both array and comma-separated string formats
 *
 * @param globs - The globs field value (array, string, or undefined)
 * @returns Parsed array of glob patterns
 */
export function parseGlobsField(globs: string[] | string | undefined | null): string[] {
  if (!globs) {
    return [];
  }

  if (Array.isArray(globs)) {
    return globs;
  }

  if (typeof globs === "string") {
    // Split by comma and trim whitespace
    return globs
      .split(",")
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0);
  }

  return [];
}

/**
 * Check if any of the provided files match the glob patterns
 *
 * @param patterns - Array of glob patterns (supports negation with !)
 * @param files - Array of file paths to test
 * @returns True if at least one file matches the patterns
 */
export function matchesGlobPatterns(patterns: string[], files: string[]): boolean {
  if (patterns.length === 0 || files.length === 0) {
    return false;
  }

  // Separate positive and negative patterns
  const positivePatterns: string[] = [];
  const negativePatterns: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      negativePatterns.push(pattern.slice(1));
    } else {
      positivePatterns.push(pattern);
    }
  }

  // Check if any file matches
  for (const file of files) {
    // First check if it matches any positive pattern
    let matches = false;

    if (positivePatterns.length === 0) {
      // If no positive patterns, assume match (only negations)
      matches = true;
    } else {
      // Check positive patterns
      for (const pattern of positivePatterns) {
        if (matchGlob(file, pattern)) {
          matches = true;
          break;
        }
      }
    }

    // If matches positive, check it's not excluded by negative patterns
    if (matches) {
      let excluded = false;
      for (const pattern of negativePatterns) {
        if (matchGlob(file, pattern)) {
          excluded = true;
          break;
        }
      }

      if (!excluded) {
        return true; // Found a file that matches and isn't excluded
      }
    }
  }

  return false;
}

/**
 * Simple glob pattern matching implementation
 * Supports:
 * - * for any characters except /
 * - ** for any characters including /
 * - ? for single character
 * - Exact matches
 *
 * @param filePath - The file path to test
 * @param pattern - The glob pattern
 * @returns True if the file matches the pattern
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // Normalize paths
  filePath = filePath.replace(/\\/g, "/");
  pattern = pattern.replace(/\\/g, "/");

  // Exact match
  if (pattern.indexOf("*") === -1 && pattern.indexOf("?") === -1) {
    return filePath === pattern;
  }

  // Convert glob pattern to regex
  let regexPattern = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      // Check for **
      if (pattern[i + 1] === "*") {
        // ** matches any characters including /
        regexPattern += ".*";
        i += 2;
        // Skip following / if present
        if (pattern[i] === "/") {
          i++;
        }
      } else {
        // * matches any characters except /
        regexPattern += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      // ? matches single character except /
      regexPattern += "[^/]";
      i++;
    } else if (char === ".") {
      // Escape dot
      regexPattern += "\\.";
      i++;
    } else if (char === "/" || char === "\\") {
      // Normalize path separators
      regexPattern += "/";
      i++;
    } else if ("[]()+{}^$|".includes(char)) {
      // Escape other regex special characters
      regexPattern += `\\${char}`;
      i++;
    } else {
      // Regular character
      regexPattern += char;
      i++;
    }
  }

  regexPattern += "$";

  try {
    const regex = new RegExp(regexPattern);
    return regex.test(filePath);
  } catch {
    // If regex is invalid, fall back to simple includes check
    return filePath.includes(pattern.replace(/\*/g, ""));
  }
}
