/**
 * Command Truncation Utility
 *
 * Provides utilities for truncating verbose git commands in error messages
 * while preserving essential debugging information.
 */

/**
 * Configuration for command truncation
 */
export interface TruncationConfig {
  /** Maximum total command length (default: 150) */
  maxLength?: number;
  /** Maximum path segment length before truncation (default: 40) */
  maxPathLength?: number;
  /** Whether to show file extensions when truncating paths (default: true) */
  preserveExtensions?: boolean;
  /** Truncation indicator (default: "...") */
  ellipsis?: string;
}

const DEFAULT_CONFIG: Required<TruncationConfig> = {
  maxLength: 150,
  maxPathLength: 40,
  preserveExtensions: true,
  ellipsis: "...",
};

/**
 * Truncates a git command for display in error messages while preserving
 * essential debugging information.
 *
 * @param command The full git command to truncate
 * @param config Optional truncation configuration
 * @returns Truncated command that fits within specified limits
 *
 * @example
 * ```typescript
 * const longCommand = "git -C /very/long/path/to/session/workspace clone https://github.com/org/repo.git /destination";
 * const truncated = truncateGitCommand(longCommand);
 * // Result: "git -C .../workspace clone https://github.com/org/repo.git .../destination"
 * ```
 */
export function truncateGitCommand(command: string, config: TruncationConfig = {}): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // If command is already short enough, return as-is
  if (command.length <= cfg.maxLength) {
    return command;
  }

  // Parse the command into components
  const parts = command.split(" ");
  const gitIndex = parts.findIndex((part) => part === "git" || part.endsWith("/git"));

  if (gitIndex === -1) {
    // Not a git command, simple truncation
    return simpleTruncate(command, cfg.maxLength, cfg.ellipsis);
  }

  // Separate git command parts
  const preGit = parts.slice(0, gitIndex).join(" ");
  const gitCommand = parts[gitIndex];
  const postGit = parts.slice(gitIndex + 1);

  // Process git-specific parts
  const processedParts: string[] = [];

  for (let i = 0; i < postGit.length; i++) {
    const part = postGit[i];

    // Handle -C (working directory) flag
    if (part === "-C" && i + 1 < postGit.length) {
      processedParts.push(part);
      processedParts.push(
        truncatePath(postGit[i + 1], cfg.maxPathLength, cfg.ellipsis, cfg.preserveExtensions)
      );
      i++; // Skip next part as we processed it
      continue;
    }

    // Handle potential file paths (look for common path patterns)
    if (isLikelyPath(part)) {
      processedParts.push(
        truncatePath(part, cfg.maxPathLength, cfg.ellipsis, cfg.preserveExtensions)
      );
    } else {
      processedParts.push(part);
    }
  }

  // Reconstruct command
  const reconstructed = [preGit, gitCommand, ...processedParts].filter(Boolean).join(" ");

  // If still too long, apply simple truncation as fallback
  if (reconstructed.length > cfg.maxLength) {
    return simpleTruncate(reconstructed, cfg.maxLength, cfg.ellipsis);
  }

  return reconstructed;
}

/**
 * Truncates a file path intelligently, preserving important parts
 */
function truncatePath(
  path: string,
  maxLength: number,
  ellipsis: string,
  preserveExtensions: boolean
): string {
  if (path.length <= maxLength) {
    return path;
  }

  // Special handling for session workspace paths
  if (path.includes("/sessions/")) {
    const sessionMatch = path.match(/.*\/sessions\/([^\/]+)(\/.*)?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const remainder = sessionMatch[2] || "";

      if (remainder) {
        // Show session + end of path
        const pathParts = remainder.split("/").filter(Boolean);
        if (pathParts.length > 0) {
          const fileName = pathParts[pathParts.length - 1];
          const hasExtension = preserveExtensions && fileName.includes(".");

          // Try to preserve filename if it has an extension
          if (hasExtension) {
            const truncatedRemainder = `${ellipsis}/${fileName}`;
            const result = `${ellipsis}/sessions/${sessionId}${truncatedRemainder}`;

            if (result.length <= maxLength) {
              return result;
            }
          }

          // Fallback to showing just the directory structure
          if (pathParts.length > 1) {
            const truncatedRemainder = `${ellipsis}/${fileName}`;
            const result = `${ellipsis}/sessions/${sessionId}${truncatedRemainder}`;

            if (result.length <= maxLength) {
              return result;
            }
          }
        }
      }

      return `${ellipsis}/sessions/${sessionId}`;
    }
  }

  // General path truncation
  const pathParts = path.split("/");

  if (pathParts.length <= 2) {
    return simpleTruncate(path, maxLength, ellipsis);
  }

  // Try to preserve filename if it has an extension
  const lastPart = pathParts[pathParts.length - 1];
  const hasExtension = preserveExtensions && lastPart.includes(".");

  if (hasExtension) {
    const basePath = `${ellipsis}/${lastPart}`;
    if (basePath.length <= maxLength) {
      return basePath;
    }
  }

  // Try to show first and last parts
  const firstPart = pathParts[0] || "";
  const lastPartToShow = hasExtension ? lastPart : pathParts[pathParts.length - 1];

  if (firstPart && lastPartToShow !== firstPart) {
    const result = `${firstPart}/${ellipsis}/${lastPartToShow}`;
    if (result.length <= maxLength) {
      return result;
    }
  }

  // Fallback to simple truncation
  return simpleTruncate(path, maxLength, ellipsis);
}

/**
 * Checks if a string is likely to be a file path
 */
function isLikelyPath(str: string): boolean {
  // Look for common path indicators
  return (
    str.includes("/") ||
    str.includes("\\") ||
    str.startsWith("~") ||
    str.startsWith("./") ||
    str.startsWith("../") ||
    str.match(/^[A-Za-z]:\\/)
  ); // Windows absolute path
}

/**
 * Simple string truncation with ellipsis
 */
function simpleTruncate(str: string, maxLength: number, ellipsis: string): string {
  if (str.length <= maxLength) {
    return str;
  }

  const truncateLength = maxLength - ellipsis.length;
  if (truncateLength <= 0) {
    return ellipsis.substring(0, maxLength);
  }

  return str.substring(0, truncateLength) + ellipsis;
}

/**
 * Truncates working directory paths for display context
 */
export function truncateWorkingDirectory(workdir: string, config: TruncationConfig = {}): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return truncatePath(workdir, cfg.maxPathLength, cfg.ellipsis, cfg.preserveExtensions);
}
