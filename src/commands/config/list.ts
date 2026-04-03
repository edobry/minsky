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
function maskCredentials(
  config: Record<string, unknown>,
  showSecrets: boolean
): Record<string, unknown> {
  if (showSecrets) {
    return config;
  }

  const masked = JSON.parse(JSON.stringify(config)) as Record<string, unknown>; // Deep clone

  // Mask AI provider API keys
  const maskedAi = masked.ai as Record<string, unknown> | undefined;
  if (maskedAi?.providers) {
    const providers = maskedAi.providers as Record<string, Record<string, unknown>>;
    for (const [, providerConfig] of Object.entries(providers)) {
      if (providerConfig && typeof providerConfig === "object") {
        if (providerConfig.apiKey) {
          providerConfig.apiKey = `${"*".repeat(20)} (configured)`;
        }
      }
    }
  }

  // Mask GitHub token
  const maskedGithub = masked.github as Record<string, unknown> | undefined;
  if (maskedGithub?.token) {
    maskedGithub.token = `${"*".repeat(20)} (configured)`;
  }

  // Mask any other potential credential fields
  const maskedSessiondb = masked.sessiondb as Record<string, unknown> | undefined;
  if (maskedSessiondb?.connectionString) {
    maskedSessiondb.connectionString = `${"*".repeat(20)} (configured)`;
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

        // Show ALL configuration properties except deprecated ones
        const { backend: _deprecatedBackend, ...resolved } = config;

        // Apply credential masking unless explicitly requested to show secrets
        const resolvedRecord = resolved as unknown as Record<string, unknown>;
        const metadataRecord = metadata as unknown as Record<string, unknown>;
        const maskedConfig = maskCredentials(resolvedRecord, options.showSecrets || false);

        if (options.json) {
          const output = {
            resolved,
            metadata,
            sources: metadata.sources || [],
          };
          await Bun.write(Bun.stdout, `${JSON.stringify(output, undefined, 2)}\n`);
        } else {
          await displayConfigurationSources(
            resolvedRecord,
            metadataRecord,
            options.showSecrets || false
          );
        }
      } catch (error) {
        await Bun.write(Bun.stderr, `Failed to load configuration: ${error}\n`);
        exit(1);
      }
    });
}

async function displayConfigurationSources(
  resolved: Record<string, unknown>,
  metadata: Record<string, unknown>,
  showSecrets: boolean
) {
  await Bun.write(Bun.stdout, "CONFIGURATION SOURCES\n");
  await Bun.write(Bun.stdout, `${"=".repeat(40)}\n`);

  // Show source precedence
  const sources = metadata.sources as Array<Record<string, unknown>> | undefined;
  if (sources && sources.length > 0) {
    await Bun.write(Bun.stdout, "Source Precedence (highest to lowest):\n");
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (!source) continue;
      await Bun.write(Bun.stdout, `  ${i + 1}. ${source.name || source.type || "Unknown"}\n`);
    }
  } else {
    await Bun.write(Bun.stdout, "Source information not available\n");
  }

  await Bun.write(Bun.stdout, "\nResolved Configuration:\n");
  await Bun.write(Bun.stdout, `Backend: ${resolved.backend}\n`);

  const sessiondb = resolved.sessiondb as Record<string, unknown> | undefined;
  if (sessiondb) {
    await Bun.write(Bun.stdout, `SessionDB Backend: ${sessiondb.backend}\n`);
  }

  const github = resolved.github as Record<string, unknown> | undefined;
  if (github?.token) {
    await Bun.write(Bun.stdout, "GitHub: Configured\n");
  }

  const ai = resolved.ai as Record<string, unknown> | undefined;
  if (ai?.providers) {
    const providers = ai.providers as Record<string, Record<string, unknown>>;
    const configuredProviders = Object.keys(providers).filter(
      (provider) => providers[provider]?.apiKey
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
