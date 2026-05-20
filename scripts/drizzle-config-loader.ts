#!/usr/bin/env bun
/**
 * Helper script for drizzle-kit configuration
 * Loads database credentials from Minsky configuration system and outputs as JSON
 * Used to work around drizzle-kit's lack of top-level await support
 */

// tsyringe (transitively imported via configuration/backend-detection) requires
// reflect-metadata to be loaded at the entry point.
import "reflect-metadata";
import { loadConfiguration } from "../src/domain/configuration/loader.js";

async function main() {
  try {
    const configResult = await loadConfiguration();
    const config = configResult.config;

    // Extract database configuration
    const dbConfig = {
      postgres: {
        connectionString: config.persistence?.postgres?.connectionString || null,
      },
      sqlite: {
        path: config.persistence?.sqlite?.dbPath || null,
      },
      backend: config.persistence?.backend || "sqlite",
    };

    // Output as JSON for consumption by drizzle config
    console.log(JSON.stringify(dbConfig, null, 2));
  } catch (error) {
    console.error("Failed to load Minsky configuration:", error);
    process.exit(1);
  }
}

main();
