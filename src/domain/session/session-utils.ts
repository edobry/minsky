import { RepositoryBackendType } from "../repository/index";

/**
 * Pure utility functions for session domain logic.
 * No I/O, no side effects, deterministic.
 */

/**
 * Parse a git commit message into a PR title and body.
 *
 * - First line becomes the title.
 * - Remaining non-empty lines form the body.
 * - If the first body line duplicates the title it is dropped to prevent
 *   the duplicate from appearing in the PR description.
 */
export function parsePrDescriptionFromCommitMessage(commitMessage: string): {
  title: string;
  body: string;
} {
  const lines = commitMessage.trim().split("\n");
  const title = lines[0] || "";

  const bodyLines = lines.slice(1).filter((line) => line.trim() !== "");

  let body = "";
  if (bodyLines.length > 0) {
    const firstBodyLine = bodyLines[0]?.trim() || "";
    if (firstBodyLine === title.trim()) {
      body = bodyLines.slice(1).join("\n").trim();
    } else {
      body = bodyLines.join("\n").trim();
    }
  }

  return { title, body };
}

/**
 * Derive the repository backend type from a session record's stored fields.
 *
 * When `backendType` is explicitly set it is used directly; otherwise the
 * `repoUrl` is inspected for well-known patterns (file path, github.com).
 */
export function resolveBackendType(
  backendType: string | undefined,
  repoUrl: string
): RepositoryBackendType {
  if (backendType) {
    switch (backendType) {
      case "github":
        return RepositoryBackendType.GITHUB;
      case "remote":
        return RepositoryBackendType.REMOTE;
      case "local":
      default:
        return RepositoryBackendType.LOCAL;
    }
  }

  // Infer from repoUrl for backward compatibility
  if (repoUrl.startsWith("/") || repoUrl.startsWith("file://")) {
    return RepositoryBackendType.LOCAL;
  } else if (repoUrl.includes("github.com")) {
    return RepositoryBackendType.GITHUB;
  } else {
    return RepositoryBackendType.REMOTE;
  }
}
