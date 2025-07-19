/**
 * Config Show Command
 */

import { z } from "zod";
import { Command } from "commander";
import { log } from "../../utils/logger";
import { exit } from "../../utils/process";
import { getConfiguration } from "../../domain/configuration";

interface ShowOptions {
  json?: boolean;
}

export function createConfigShowCommand(): Command {
  return new Command("show")
    .description("Show the final resolved configuration")
    .option("--json", "Output in JSON format", false)
    .option("--working-dir <dir>", "Working directory", process.cwd()).action(async (options: ShowOptions) => {
      try {
        // Use new configuration system for resolved configuration
        const config = getConfiguration();
        const resolved = {
          backend: config.backend,
          backendConfig: config.backendConfig,
          sessiondb: config.sessiondb,
          ai: config.ai,
          github: config.github,
          logger: config.logger,
        };

        if (options.json) {
          await Bun.write(Bun.stdout, `${JSON.stringify(resolved, null, 2)}\n`);
        } else {
          await displayResolvedConfiguration(resolved);
        }
      } catch (error) {
        await Bun.write(Bun.stderr, `Failed to load configuration: ${error}\n`);
        exit(1);
      }
    });
}

async function displayResolvedConfiguration(resolved: any) {
  await Bun.write(Bun.stdout, "RESOLVED CONFIGURATION\n");
  await Bun.write(Bun.stdout, `${"=".repeat(40)}\n`);

  await Bun.write(Bun.stdout, `Backend: ${resolved.backend}\n`);

  if (resolved.backendConfig && Object.keys(resolved.backendConfig).length > 0) {
    await Bun.write(Bun.stdout, "\nBackend Configuration:\n");
    for (const [backend, config] of Object.entries(resolved.backendConfig)) {
      if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
        await Bun.write(Bun.stdout, `  ${backend}:\n`);
        for (const [key, value] of Object.entries(config as object)) {
          await Bun.write(Bun.stdout, `    ${key}: ${value}\n`);
        }
      }
    }
  }

  if (resolved.sessiondb) {
    await Bun.write(Bun.stdout, `\nSessionDB Backend: ${resolved.sessiondb.backend}\n`);
  }

  if (resolved.github) {
    await Bun.write(Bun.stdout, "\nGitHub Configuration:\n");
    if (resolved.github.token) {
      await Bun.write(Bun.stdout, `  Token: ${"*".repeat(20)} (hidden)\n`);
    }
    if (resolved.github.organization) {
      await Bun.write(Bun.stdout, `  Organization: ${resolved.github.organization}\n`);
    }
  }

  if (resolved.ai && resolved.ai.providers) {
    await Bun.write(Bun.stdout, "\nAI Providers:\n");
    for (const [provider, config] of Object.entries(resolved.ai.providers)) {
      if (config && typeof config === "object") {
        await Bun.write(Bun.stdout, `  ${provider}:\n`);
        const providerConfig = config as any;
        if (providerConfig.model) {
          await Bun.write(Bun.stdout, `    Model: ${providerConfig.model}\n`);
        }
        if (providerConfig.apiKey) {
          await Bun.write(Bun.stdout, `    API Key: ${"*".repeat(20)} (hidden)\n`);
        }
      }
    }
  }
}
