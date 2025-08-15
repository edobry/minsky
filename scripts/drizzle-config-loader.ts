#!/usr/bin/env bun
/**
 * Helper script for drizzle-kit configuration
 * Loads database credentials from Minsky configuration system and outputs as JSON
 * Used to work around drizzle-kit's lack of top-level await support
 */

import { loadConfiguration } from "../src/domain/configuration/loader.js";

async function main() {
  try {
    const configResult = await loadConfiguration();
    const config = configResult.config;

    // Extract database configuration
    const dbConfig = {
      postgres: {
        connectionString: config.sessiondb?.postgres?.connectionString || null,
      },
      sqlite: {
        path: config.sessiondb?.sqlite?.path || null,
      },
      backend: config.sessiondb?.backend || "sqlite",
    };

    // Output as JSON for consumption by drizzle config
    console.log(JSON.stringify(dbConfig, null, 2));
  } catch (error) {
    console.error("Failed to load Minsky configuration:", error);
    process.exit(1);
  }
}

main();
