/**
 * CLI Composition Root
 *
 * Thin wrapper around createDomainContainer() for the CLI entry point.
 * The CLI calls setupConfiguration() separately (in cli.ts) with its own
 * error boundary, so this passes skipConfigSetup: true.
 *
 * @see mt#761 spec, "Phase 2: Create composition roots and wire CLI"
 * @see mt#2098 — domain bootstrap extraction
 */

import { createDomainContainer } from "./domain";
import type { AppContainerInterface } from "./types";

/**
 * Create a container with real service factories for CLI usage.
 * Does NOT call initialize() — the caller controls when async services start.
 *
 * Delegates to createDomainContainer() with skipConfigSetup since the CLI
 * entry point handles configuration initialization with its own error boundary.
 */
export async function createCliContainer(): Promise<AppContainerInterface> {
  return createDomainContainer({ skipConfigSetup: true });
}
