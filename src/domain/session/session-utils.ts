/**
 * Pure utility functions for session domain logic.
 * No I/O, no side effects, deterministic.
 *
 * ## When to extract vs when DI injection is sufficient
 *
 * Extract a pure function when:
 * - The logic is deterministic (same input → same output, no side effects)
 * - It's embedded inside an async/I/O function but doesn't use any I/O itself
 * - It's duplicated across multiple files (extraction eliminates copy-paste)
 * - Testing it requires constructing a full service graph just to reach the logic
 *
 * Use DI injection instead when:
 * - The logic inherently requires I/O (database reads, git commands, network)
 * - The function's purpose IS orchestrating I/O operations
 * - Swapping the implementation at runtime is needed (e.g., fake backends in tests)
 *
 * Rule of thumb: if you can write the function's tests without any mocks, it's a
 * pure extraction candidate. If tests need mocks, it belongs behind a DI interface.
 */

import { RepositoryBackendType } from "../repository/index";

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
  _backendType: string | undefined,
  _repoUrl: string
): RepositoryBackendType {
  // Only GitHub is supported after LOCAL/REMOTE backend removal (mt#880)
  return RepositoryBackendType.GITHUB;
}
