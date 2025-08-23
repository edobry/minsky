/**
 * Config Show Command
 */

import { z } from "zod";
import { Command } from "commander";
import { log } from "../../utils/logger";
import { exit } from "../../utils/process";
import { getConfiguration } from "../../domain/configuration";
import { DefaultCredentialResolver } from "../../domain/configuration/credential-resolver";
import { TaskBackend } from "../../domain/configuration/backend-detection";

interface ShowOptions {
  json?: boolean;
}

export function createConfigShowCommand(): Command {
  return new Command("show")
    .description("Show the final resolved configuration")
    .option("--json", "Output in JSON format", false)
    .option("--working-dir <dir>", "Working directory", process.cwd())
    .action(async (options: ShowOptions) => {
      try {
        // Use new configuration system for resolved configuration
        const config = getConfiguration();

        // Gather credential information
        const credentialResolver = new DefaultCredentialResolver();
        const credentials = await gatherCredentialInfo(credentialResolver, config);

        // Show ALL configuration properties dynamically instead of hardcoding subset
        const resolved = {
          ...config, // Include all configuration properties
          credentials,
        };

        if (options.json) {
          await Bun.write(Bun.stdout, `${JSON.stringify(resolved, null, 2)}\n`);
        } else {
          await displayComprehensiveConfiguration(resolved);
        }
      } catch (error) {
        await Bun.write(Bun.stderr, `Failed to load configuration: ${error}\n`);
        exit(1);
      }
    });
}

async function gatherCredentialInfo(credentialResolver: DefaultCredentialResolver, config: any) {
  const credentials: any = {};

  // Check GitHub credentials
  try {
    const githubToken = await credentialResolver.getCredential("github");
    if (githubToken) {
      credentials.github = {
        token: `${"*".repeat(20)} (configured)`,
        source: "environment", // Simplified for display
      };
    }
  } catch (error) {
    // Ignore credential resolution errors for display
  }

  // Check AI provider credentials
  if (config.ai?.providers) {
    credentials.ai = {};
    for (const [provider, providerConfig] of Object.entries(config.ai.providers)) {
      if (providerConfig && typeof providerConfig === "object") {
        const providerCfg = providerConfig as any;
        if (providerCfg.apiKey) {
          credentials.ai[provider] = {
            apiKey: `${"*".repeat(20)} (configured)`,
            source: "environment",
          };
        }
      }
    }
  }

  return credentials;
}

async function displayComprehensiveConfiguration(resolved: any) {
  await Bun.write(Bun.stdout, "📋 CURRENT CONFIGURATION\n");
  await Bun.write(Bun.stdout, `${"=".repeat(50)}\n\n`);

  // Task Storage Backend
  await displayTaskStorageConfig(resolved);

  // Session Storage (controlled by root "backend" property - confusing naming!)
  await displaySessionStorageConfig(resolved);

  // Authentication
  await displayAuthenticationConfig(resolved);

  // AI Configuration
  await displayAIConfig(resolved);

  // GitHub Configuration
  await displayGitHubConfig(resolved);

  // Logger Configuration
  await displayLoggerConfig(resolved);

  // Backend-specific Configuration
  await displayBackendConfig(resolved);
}

async function displayTaskStorageConfig(resolved: any) {
  await Bun.write(Bun.stdout, "📁 TASK STORAGE\n");
  const taskBackend = resolved.tasks?.backend || resolved.backend;
  await Bun.write(Bun.stdout, `   Backend: ${getBackendDisplayName(taskBackend)}\n`);

  if (taskBackend === "github-issues" && resolved.backendConfig?.["github-issues"]) {
    const github = resolved.backendConfig["github-issues"];
    await Bun.write(Bun.stdout, `   Repository: ${github.owner}/${github.repo}\n`);
  }
  await Bun.write(Bun.stdout, "\n");
}

async function displaySessionStorageConfig(resolved: any) {
  await Bun.write(Bun.stdout, "💾 SESSION STORAGE\n");

  // Note: The root "backend" property controls session storage, NOT task storage!
  // This is confusing naming that should be clarified
  await Bun.write(
    Bun.stdout,
    `   Storage Backend: ${getSessionBackendDisplayName(resolved.backend || "json")}\n`
  );

  if (resolved.sessiondb) {
    const sessionBackend = resolved.sessiondb.backend || resolved.backend || "sqlite";

    if (sessionBackend === "sqlite" && resolved.sessiondb.sqlite?.path) {
      await Bun.write(Bun.stdout, `   SQLite Path: ${resolved.sessiondb.sqlite.path}\n`);
    } else if (sessionBackend === "postgres" && resolved.sessiondb.postgres?.connectionString) {
      await Bun.write(Bun.stdout, `   Connection: ${"*".repeat(20)} (configured)\n`);
    } else if (sessionBackend === "json") {
      await Bun.write(
        Bun.stdout,
        `   JSON File Storage: ${resolved.sessiondb.json?.filePath || "default location"}\n`
      );
    }
  }
  await Bun.write(Bun.stdout, "\n");
}

async function displayAuthenticationConfig(resolved: any) {
  if (!resolved.credentials || Object.keys(resolved.credentials).length === 0) {
    return;
  }

  await Bun.write(Bun.stdout, "🔐 AUTHENTICATION\n");

  if (resolved.credentials.github) {
    await Bun.write(Bun.stdout, `   GitHub: ${resolved.credentials.github.token}\n`);
  }

  if (resolved.credentials.ai && Object.keys(resolved.credentials.ai).length > 0) {
    const configuredProviders = Object.keys(resolved.credentials.ai);
    await Bun.write(Bun.stdout, `   AI Providers: ${configuredProviders.join(", ")}\n`);
  }

  await Bun.write(Bun.stdout, "\n");
}

async function displayAIConfig(resolved: any) {
  if (!resolved.ai?.providers || Object.keys(resolved.ai.providers).length === 0) {
    return;
  }

  await Bun.write(Bun.stdout, "🤖 AI CONFIGURATION\n");

  if (resolved.ai.defaultProvider) {
    await Bun.write(Bun.stdout, `   Default Provider: ${resolved.ai.defaultProvider}\n`);
  }

  await Bun.write(Bun.stdout, "   Configured Providers:\n");
  for (const [provider, config] of Object.entries(resolved.ai.providers)) {
    if (config && typeof config === "object") {
      const providerConfig = config as any;
      await Bun.write(Bun.stdout, `     ${provider}:\n`);

      if (providerConfig.model) {
        await Bun.write(Bun.stdout, `       Model: ${providerConfig.model}\n`);
      }

      if (providerConfig.baseUrl) {
        await Bun.write(Bun.stdout, `       Base URL: ${providerConfig.baseUrl}\n`);
      }

      if (providerConfig.maxTokens) {
        await Bun.write(Bun.stdout, `       Max Tokens: ${providerConfig.maxTokens}\n`);
      }

      if (providerConfig.temperature !== undefined) {
        await Bun.write(Bun.stdout, `       Temperature: ${providerConfig.temperature}\n`);
      }

      const hasApiKey = providerConfig.apiKey || resolved.credentials?.ai?.[provider];
      if (hasApiKey) {
        await Bun.write(Bun.stdout, `       API Key: ${"*".repeat(20)} (configured)\n`);
      }
    }
  }

  await Bun.write(Bun.stdout, "\n");
}

async function displayGitHubConfig(resolved: any) {
  if (!resolved.github || Object.keys(resolved.github).length === 0) {
    return;
  }

  await Bun.write(Bun.stdout, "🐙 GITHUB CONFIGURATION\n");

  if (resolved.github.organization) {
    await Bun.write(Bun.stdout, `   Organization: ${resolved.github.organization}\n`);
  }

  if (resolved.github.baseUrl) {
    await Bun.write(Bun.stdout, `   Base URL: ${resolved.github.baseUrl}\n`);
  }

  await Bun.write(Bun.stdout, "\n");
}

async function displayLoggerConfig(resolved: any) {
  if (!resolved.logger) {
    return;
  }

  const logger = resolved.logger;
  const hasNonDefaultSettings =
    logger.mode !== "auto" ||
    logger.level !== "info" ||
    logger.enableAgentLogs === true ||
    logger.logFile;

  if (!hasNonDefaultSettings) {
    return;
  }

  await Bun.write(Bun.stdout, "📊 LOGGER CONFIGURATION\n");

  if (logger.mode && logger.mode !== "auto") {
    await Bun.write(Bun.stdout, `   Mode: ${logger.mode}\n`);
  }

  if (logger.level && logger.level !== "info") {
    await Bun.write(Bun.stdout, `   Level: ${logger.level}\n`);
  }

  if (logger.enableAgentLogs === true) {
    await Bun.write(Bun.stdout, `   Agent Logs: enabled\n`);
  }

  if (logger.logFile) {
    await Bun.write(Bun.stdout, `   Log File: ${logger.logFile}\n`);
  }

  await Bun.write(Bun.stdout, "\n");
}

async function displayBackendConfig(resolved: any) {
  if (!resolved.backendConfig || Object.keys(resolved.backendConfig).length === 0) {
    return;
  }

  await Bun.write(Bun.stdout, "⚙️  BACKEND CONFIGURATION\n");
  for (const [backend, config] of Object.entries(resolved.backendConfig)) {
    if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
      await Bun.write(Bun.stdout, `   ${backend}:\n`);
      for (const [key, value] of Object.entries(config as object)) {
        await Bun.write(Bun.stdout, `     ${key}: ${value}\n`);
      }
    }
  }
  await Bun.write(Bun.stdout, "\n");
}

function getBackendDisplayName(backend: string): string {
  switch (backend) {
    case TaskBackend.MARKDOWN:
      return "Markdown files (process/tasks.md)";
    case TaskBackend.JSON_FILE:
      return "JSON files";
    case TaskBackend.GITHUB_ISSUES:
      return "GitHub Issues";
    case "minsky":
      return "Minsky database";
    default:
      return backend;
  }
}

function getSessionBackendDisplayName(backend: string): string {
  switch (backend) {
    case "json":
      return "JSON files";
    case "sqlite":
      return "SQLite database";
    case "postgres":
      return "PostgreSQL database";
    default:
      return backend;
  }
}
