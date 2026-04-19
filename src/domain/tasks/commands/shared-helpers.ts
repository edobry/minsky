/**
 * Task Command Shared Helpers
 *
 * Common utilities used across task command sub-modules.
 */

import { resolveRepoPath as resolveRepoPathBase } from "../../repo-utils";
import type { SessionProviderInterface } from "../../session/index";

// Re-export task status constants and schemas for callers that import from taskCommands
export { TASK_STATUS } from "../taskConstants";
export type { TaskStatus } from "../taskConstants";

/**
 * Module-level wrapper that resolves a repo path using a session provider.
 *
 * When `options.session` is set, `sessionProvider` is required to resolve
 * the session to a repo path. When `options.session` is not set, the
 * provider is unused and may be omitted.
 */
export async function resolveRepoPath(
  options: { repo?: string; session?: string },
  sessionProvider?: SessionProviderInterface
): Promise<string> {
  if (options.session && !sessionProvider) {
    throw new Error(
      "sessionProvider is required when resolving a repo path from a session. " +
        "Pass sessionProvider from the DI container."
    );
  }
  if (!sessionProvider) {
    // No session in options and no provider — resolve without session lookup.
    // When repo is specified, use it directly. Otherwise fall back to cwd.
    if (options.repo) return options.repo;
    return process.cwd();
  }
  return resolveRepoPathBase(options, { sessionProvider });
}

/**
 * Normalize task ID inputs to qualified form when appropriate.
 */
export function normalizeTaskIdInput(input: unknown): string {
  const raw = Array.isArray(input) ? String(input[0] ?? "").trim() : String(input ?? "").trim();
  if (!raw) return raw;
  // Already qualified like mt#123 or gh#456
  if (/^[a-z-]+#\d+$/.test(raw)) return raw;
  // Accept forms like "#123" or "123" and normalize to mt#123 (minsky is the default backend)
  const numeric = raw.startsWith("#") ? raw.slice(1) : raw;
  return `mt#${numeric}`;
}
