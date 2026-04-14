/**
 * Shared helpers for task command functions.
 * Internal to the commands/ sub-directory — not re-exported from taskCommands.ts.
 */
import { resolveRepoPath as resolveRepoPathBase } from "../../repo-utils";
import { getSharedSessionProvider } from "../../session/session-provider-cache";
import {
  createConfiguredTaskService as createConfiguredTaskServiceImpl,
  type TaskServiceOptions,
  type TaskServiceInterface,
} from "../taskService";

export type { TaskServiceOptions, TaskServiceInterface };
export { createConfiguredTaskServiceImpl as createConfiguredTaskService };

/**
 * Module-level wrapper that lazily creates a sessionProvider for bare resolveRepoPath calls.
 * This is a composition boundary — domain functions above should receive deps injected.
 */
export async function resolveRepoPath(options: {
  repo?: string;
  session?: string;
}): Promise<string> {
  const sessionProvider = await getSharedSessionProvider();
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
