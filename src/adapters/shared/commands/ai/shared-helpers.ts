/**
 * Shared helpers for AI commands
 *
 * Provides getResolvedConfig() used across all AI command sub-modules.
 */

import { getConfiguration } from "@minsky/domain/configuration";
import type { ResolvedConfig, BackendConfig } from "@minsky/domain/configuration/types";

/**
 * Get resolved configuration, mapped to ResolvedConfig for domain service
 * compatibility. The Configuration type from zod schema inference and
 * ResolvedConfig share the same fields; this function builds the mapped object
 * explicitly so TypeScript can verify each field assignment.
 */
export function getResolvedConfig(): ResolvedConfig {
  const config = getConfiguration();
  return {
    backendConfig: config.backendConfig as BackendConfig,
    persistence: config.persistence,
    github: config.github,
    ai: config.ai,
    logger: config.logger,
    tasks: config.tasks as Record<string, unknown> | undefined,
  };
}

/**
 * Default timeout for a single `ai.complete` provider call (mt#2727).
 *
 * Without a bound, an MCP caller of `ai_complete` could hang until the MCP
 * client's own idle timeout (observed: 1800s) with zero feedback. 60s is a
 * generous ceiling for a single completion call while still failing fast
 * enough to be actionable.
 */
export const DEFAULT_AI_COMPLETE_TIMEOUT_MS = 60_000;

/**
 * Race a promise against a timeout, rejecting with an actionable error
 * message when the timeout wins. Always clears the timer so a resolved/
 * rejected `promise` doesn't leave a dangling timer keeping the process
 * alive (relevant for the long-lived MCP server process).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
