/**
 * Task Command Shared Helpers
 *
 * Common utilities used across task command sub-modules.
 */

import { resolveRepoPath as resolveRepoPathBase } from "../../repo-utils";
import { getSharedSessionProvider } from "../../session/session-provider-cache";
import type { SessionProviderInterface } from "../../session/index";

// Re-export task status constants and schemas for callers that import from taskCommands
export { TASK_STATUS } from "../taskConstants";
export type { TaskStatus } from "../taskConstants";

/**
 * Module-level wrapper that lazily creates a sessionProvider for bare resolveRepoPath calls.
 * This is a composition boundary — domain functions above should receive deps injected.
 */
export async function resolveRepoPath(
  options: { repo?: string; session?: string },
  sessionProvider?: SessionProviderInterface
): Promise<string> {
  const provider = sessionProvider ?? (await getSharedSessionProvider());
  return resolveRepoPathBase(options, { sessionProvider: provider });
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
