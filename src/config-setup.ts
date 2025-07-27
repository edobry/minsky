/**
 * Configuration System Setup
 *
 * Initializes the custom type-safe configuration system.
 * This file must be imported before any code that uses configuration.
 */

import { initializeConfiguration, CustomConfigFactory } from "./domain/configuration";
import { exit } from "./utils/process";

/**
 * Initialize the custom configuration system
 *
 * This replaces node-config with our custom type-safe configuration system.
 * Must be called before any configuration access.
 */
export async function setupConfiguration(): Promise<void> {
  try {
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      workingDirectory: process.cwd(),
      enableCache: true,
    });
  } catch (error) {
    console.error("✗ Failed to initialize configuration system:", error);
    throw error;
  }
}
