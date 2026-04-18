/**
 * Shared helpers for AI commands
 *
 * Provides getResolvedConfig() used across all AI command sub-modules.
 */

import { getConfiguration } from "../../../../domain/configuration";
import type { ResolvedConfig, BackendConfig } from "../../../../domain/configuration/types";

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
