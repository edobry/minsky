/**
 * Strict Mode Checker
 *
 * Direct configuration check for strict mode without relying on the full configuration system
 * This is used during parameter validation when the config system might not be fully initialized
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Check if strict task IDs are enabled by directly reading the config file
 * This avoids dependency on the configuration system during parameter validation
 */
export function isStrictTaskIdsEnabled(): boolean {
  try {
    // Try to read minsky.config.json from current working directory
    const configPath = join(process.cwd(), "minsky.config.json");

    if (!existsSync(configPath)) {
      return false; // Default to permissive mode if no config
    }

    const configContent = readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);

    return config?.tasks?.strictIds === true;
  } catch (error) {
    // If any error occurs (file not found, parse error, etc.), default to permissive
    return false;
  }
}
