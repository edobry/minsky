/**
 * CLI Composition Root
 *
 * Delegates to createDomainContainer(). The CLI entry point (cli.ts)
 * initializes config at module top-level before this runs, so the domain
 * bootstrap's idempotency guard skips config setup. This wrapper exists
 * for backward compatibility with callers that import createCliContainer
 * by name.
 *
 * @see mt#761 spec, "Phase 2: Create composition roots and wire CLI"
 * @see mt#2098 — domain bootstrap extraction
 * @see mt#2100 — simplify: remove skipConfigSetup
 */

import { createDomainContainer } from "./domain";
import type { AppContainerInterface } from "./types";

/**
 * Create a container with real service factories for CLI usage.
 * Does NOT call initialize() — the caller controls when async services start.
 */
export async function createCliContainer(): Promise<AppContainerInterface> {
  return createDomainContainer();
}
