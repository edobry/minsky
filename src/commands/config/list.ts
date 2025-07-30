/**
 * Config List Command
 */

import { z } from "zod";
import { Command } from "commander";
import { log } from "../../utils/logger";
import { exit } from "../../utils/process";
import { getConfigurationProvider } from "../../domain/configuration";

interface ListOptions {
  json?: boolean;
  showSecrets?: boolean;
}

/**
 * Masks sensitive credential values in configuration
 * @param config Configuration object
 * @param showSecrets Whether to show actual secret values
 * @returns Configuration with credentials masked unless showSecrets is true
 */
function maskCredentials(config: any, showSecrets: boolean): any {
  if (showSecrets) {
    return config;
  }

  const masked = JSON.parse(JSON.stringify(config)); // Deep clone

  // Mask AI provider API keys
  if (masked.ai?.providers) {
    for (const [provider, providerConfig] of Object.entries(masked.ai.providers)) {
      if (providerConfig && typeof providerConfig === "object") {
        const cfg = providerConfig as any;
        if (cfg.apiKey) {
          cfg.apiKey = `${"*".repeat(20)} (configured)`;
        }
      }
    }
  }

  // Mask GitHub token
  if (masked.github?.token) {
    masked.github.token = `${"*".repeat(20)} (configured)`;
  }

  // Mask any other potential credential fields
  if (masked.sessiondb?.connectionString) {
    masked.sessiondb.connectionString = `${"*".repeat(20)} (configured)`;
  }

  return masked;
}

export function createConfigListCommand(): Command {
  return new Command("list")
    .description("List all configuration values and their sources")
    .option("--json", "Output in JSON format", false)
    .option(
      "--show-secrets",
      "Show actual credential values (SECURITY RISK: use with caution)",
      false
    )
    .action(async (options: ListOptions) => {
      try {
        // Use new configuration system with metadata support
        const provider = getConfigurationProvider();
        const config = provider.getConfig();
        const metadata = provider.getMetadata();

        const resolved = {
          backend: config.backend,
          backendConfig: config.backendConfig,
          sessiondb: config.sessiondb,
          ai: config.ai,
          github: config.github,
          logger: config.logger,
        };

        // Apply credential masking unless explicitly requested to show secrets
        const maskedConfig = maskCredentials(resolved, options.showSecrets || false);

        if (options.json) {
          const output = {
            resolved,
            metadata,
            sources: metadata.sources || [],
          };
          await Bun.write(Bun.stdout, `${JSON.stringify(output, undefined, 2)}\n`);
        } else {
          await displayConfigurationSources(resolved, metadata, options.showSecrets || false);
        }
      } catch (error) {
        await Bun.write(Bun.stderr, `Failed to load configuration: ${error}\n`);
        exit(1);
      }
    });
}

async function displayConfigurationSources(resolved: any, metadata: any, showSecrets: boolean) {
  await Bun.write(Bun.stdout, "CONFIGURATION SOURCES\n");
  await Bun.write(Bun.stdout, `${"=".repeat(40)}\n`);

  // Show source precedence
  if (metadata.sources && metadata.sources.length > 0) {
    await Bun.write(Bun.stdout, "Source Precedence (highest to lowest):\n");
    for (let i = 0; i < metadata.sources.length; i++) {
      const source = metadata.sources[i];
      await Bun.write(Bun.stdout, `  ${i + 1}. ${source.name || source.type || "Unknown"}\n`);
    }
  } else {
    await Bun.write(Bun.stdout, "Source information not available\n");
  }

  await Bun.write(Bun.stdout, "\nResolved Configuration:\n");
  await Bun.write(Bun.stdout, `Backend: ${resolved.backend}\n`);

  if (resolved.sessiondb) {
    await Bun.write(Bun.stdout, `SessionDB Backend: ${resolved.sessiondb.backend}\n`);
  }

  if (resolved.github && resolved.github.token) {
    await Bun.write(Bun.stdout, "GitHub: Configured\n");
  }

  if (resolved.ai && resolved.ai.providers) {
    const configuredProviders = Object.keys(resolved.ai.providers).filter(
      (provider) => resolved.ai.providers[provider].apiKey
    );
    if (configuredProviders.length > 0) {
      await Bun.write(Bun.stdout, `AI Providers: ${configuredProviders.join(", ")}\n`);
    }
  }

  if (!showSecrets) {
    await Bun.write(
      Bun.stdout,
      "\n⚠️  Credentials are masked for security. Use --show-secrets to reveal actual values.\n"
    );
  }

  await Bun.write(Bun.stdout, "\nFor detailed configuration values, use: minsky config show\n");
}
