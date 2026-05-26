/**
 * Configuration System Setup
 *
 * Initializes the custom type-safe configuration system.
 * This file must be imported before any code that uses configuration.
 */

import { initializeConfiguration, CustomConfigFactory } from "./configuration";

/**
 * Initialize the custom configuration system
 *
 * Wraps node-config replacement with our custom type-safe configuration
 * system. Must be called before any configuration access.
 *
 * Error handling is owned by the CLI boundary catch in `cli.ts` (mt#1801).
 * This function lets errors propagate; the CLI boundary recognizes
 * ConfigValidationError vs. unknown failure and renders accordingly.
 * Wrapping here would emit a duplicate log line with no remediation value.
 */
export async function setupConfiguration(): Promise<void> {
  const factory = new CustomConfigFactory();
  await initializeConfiguration(factory, {
    workingDirectory: process.cwd(),
    enableCache: true,
  });
}
