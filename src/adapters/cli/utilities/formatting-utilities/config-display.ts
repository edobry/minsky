/**
 * Configuration Display Formatters
 *
 * Functions for rendering the resolved Minsky configuration into human-readable
 * output, with and without per-value source annotations.
 */

import { TaskBackend } from "../../../../domain/configuration/backend-detection";
import {
  getBackendDisplayName,
  getSessionBackendDisplayName,
  type ResolvedConfigShape,
} from "./basic-utils";

/**
 * Format resolved configuration with source annotations
 */
export function formatResolvedConfigurationWithSources(
  resolved: Record<string, unknown>,
  effectiveValues: Record<string, { value: unknown; source: string; path: string }>
): string {
  // Helper to get source annotation for a config path
  const getSourceAnnotation = (path: string): string => {
    const valueInfo = effectiveValues[path];
    if (valueInfo) {
      return ` [${valueInfo.source}]`;
    }
    return "";
  };

  const r = resolved as ResolvedConfigShape;

  let output = "📋 CURRENT CONFIGURATION\n";

  // Task Storage
  const taskBackend = r.tasks?.backend || r.backend;
  const persistenceConfig = r.persistence || r.sessiondb;
  const persistenceBackend = persistenceConfig?.backend || "sqlite";

  // Don't show separate task storage if it's using the same database as persistence
  if (taskBackend === "minsky" && persistenceBackend === "postgres") {
    // Will be shown in unified database section below
  } else if (taskBackend) {
    const taskBackendSource =
      getSourceAnnotation("tasks.backend") || getSourceAnnotation("backend");
    output += `📁 Task Storage: ${getBackendDisplayName(taskBackend)}${taskBackendSource}`;
    if (taskBackend === "github-issues" && r.backendConfig?.["github-issues"]) {
      const github = r.backendConfig["github-issues"];
      output += ` (${github.owner}/${github.repo})`;
    }
    output += "\n";
  } else {
    output += `📁 Task Storage: Auto-detected (multi-backend mode)\n`;
  }

  // Authentication & Credentials
  const aiProviders = r.ai?.providers;
  const hasAuth =
    (r.credentials && Object.keys(r.credentials).length > 0) ||
    r.github?.token ||
    (aiProviders && Object.keys(aiProviders).some((p: string) => aiProviders[p]?.apiKey));

  if (hasAuth) {
    output += "🔐 Authentication:\n";

    // GitHub authentication
    if (r.github?.token || r.credentials?.github) {
      const githubSource = getSourceAnnotation("github.token");
      output += `   • GitHub: ✓ configured${githubSource}\n`;
    }

    // AI provider authentication
    if (aiProviders) {
      const configuredAI: string[] = [];
      const aiSources: string[] = [];
      for (const [provider, config] of Object.entries(aiProviders)) {
        if (config && typeof config === "object") {
          const providerConfig = config as Record<string, unknown>;
          if (providerConfig.apiKey) {
            configuredAI.push(provider);
            const source = getSourceAnnotation(`ai.providers.${provider}.apiKey`);
            if (source) {
              aiSources.push(`${provider}${source}`);
            }
          }
        }
      }
      if (configuredAI.length > 0) {
        const defaultProviderSource = getSourceAnnotation("ai.defaultProvider");
        output += `   • AI Providers: ${configuredAI.join(", ")} ✓${defaultProviderSource}\n`;
        if (aiSources.length > 0 && aiSources.length <= 3) {
          output += `     (${aiSources.join(", ")})\n`;
        }
      }
    }
  }

  // Storage Layer
  if (persistenceConfig) {
    const persistenceSource =
      getSourceAnnotation("persistence.backend") || getSourceAnnotation("sessiondb.backend");

    if (taskBackend === "minsky" && persistenceBackend === "postgres") {
      output += `💾 Persistence:\n   • All data stored in PostgreSQL database${persistenceSource}\n`;
    } else {
      output += "💾 Persistence:\n";
      output += `   • Backend: ${getSessionBackendDisplayName(persistenceBackend)}${persistenceSource}\n`;
    }

    if (persistenceBackend === "postgres" && persistenceConfig.postgres?.connectionString) {
      const connSource =
        getSourceAnnotation("persistence.postgres.connectionString") ||
        getSourceAnnotation("sessiondb.connectionString");
      output += `   • Connection: configured${connSource}\n`;
    }
  }

  // AI Configuration
  if (aiProviders && Object.keys(aiProviders).length > 0) {
    output += "🤖 AI Configuration:\n";

    if (r.ai?.defaultProvider) {
      const defaultSource = getSourceAnnotation("ai.defaultProvider");
      output += `   • Default Provider: ${r.ai.defaultProvider}${defaultSource}\n`;
    }

    output += "   • Configured Providers:\n";
    for (const [provider, config] of Object.entries(aiProviders)) {
      if (config && typeof config === "object") {
        const providerConfig = config as Record<string, unknown>;
        output += `     ${provider}:`;

        const details: string[] = [];
        if (providerConfig.model) {
          const modelSource = getSourceAnnotation(`ai.providers.${provider}.model`);
          details.push(`model: ${providerConfig.model}${modelSource || ""}`);
        }
        if (providerConfig.enabled !== undefined) {
          const enabledSource = getSourceAnnotation(`ai.providers.${provider}.enabled`);
          details.push(`enabled: ${providerConfig.enabled ? "yes" : "no"}${enabledSource || ""}`);
        }
        if (providerConfig.apiKey) {
          details.push("authenticated");
        }

        if (details.length > 0) {
          output += ` ${details.join(", ")}\n`;
        } else {
          output += "\n";
        }
      }
    }
  }

  // GitHub Configuration
  if (r.github && Object.keys(r.github).length > 0) {
    output += "🐙 GitHub Configuration:\n";

    if (r.github.token) {
      const tokenSource = getSourceAnnotation("github.token");
      output += `   • Token: configured${tokenSource}\n`;
    }
    if (r.github.organization) {
      const orgSource = getSourceAnnotation("github.organization");
      output += `   • Organization: ${r.github.organization}${orgSource}\n`;
    }
    if (r.github.baseUrl && r.github.baseUrl !== "https://api.github.com") {
      const urlSource = getSourceAnnotation("github.baseUrl");
      output += `   • Base URL: ${r.github.baseUrl}${urlSource}\n`;
    }
  }

  return output.trim();
}

/**
 * Format resolved configuration for display (no per-value source annotations)
 */
export function formatResolvedConfiguration(resolved: Record<string, unknown>): string {
  const r = resolved as ResolvedConfigShape;

  let output = "📋 CURRENT CONFIGURATION\n";

  // Task Storage
  // Note: tasks.backend is preferred, root backend is deprecated but kept for compatibility
  const taskBackend = r.tasks?.backend || r.backend;
  const persistenceConfig = r.persistence || r.sessiondb;
  const persistenceBackend = persistenceConfig?.backend || "sqlite";

  // Don't show separate task storage if it's using the same database as persistence
  if (taskBackend === "minsky" && persistenceBackend === "postgres") {
    // Will be shown in unified database section below
  } else if (taskBackend) {
    output += `📁 Task Storage: ${getBackendDisplayName(taskBackend)}`;
    if (taskBackend === TaskBackend.GITHUB_ISSUES && r.backendConfig?.["github-issues"]) {
      const github = r.backendConfig["github-issues"];
      output += ` (${github.owner}/${github.repo})`;
    }
    output += "\n";
  } else {
    output += `📁 Task Storage: Auto-detected (multi-backend mode)\n`;
  }

  // Authentication & Credentials
  const aiProvidersMap = r.ai?.providers;
  const hasAuth =
    (r.credentials && Object.keys(r.credentials).length > 0) ||
    r.github?.token ||
    (aiProvidersMap && Object.keys(aiProvidersMap).some((p: string) => aiProvidersMap[p]?.apiKey));

  if (hasAuth) {
    output += "🔐 Authentication:\n";

    // GitHub authentication
    if (r.github?.token || r.credentials?.github) {
      output += "   • GitHub: ✓ configured\n";
    }

    // AI provider authentication
    if (aiProvidersMap) {
      const configuredAI: string[] = [];
      for (const [provider, config] of Object.entries(aiProvidersMap)) {
        if (config && typeof config === "object") {
          const providerConfig = config as Record<string, unknown>;
          if (providerConfig.apiKey) {
            configuredAI.push(provider);
          }
        }
      }
      if (configuredAI.length > 0) {
        output += `   • AI Providers: ${configuredAI.join(", ")} ✓\n`;
      }
    }
  }

  // Storage Layer (unified for sessions, embeddings, and optionally tasks)
  // persistenceConfig already defined above
  if (persistenceConfig) {
    // Warn about legacy sessiondb usage
    if (!r.persistence && r.sessiondb) {
      output +=
        "⚠️  DEPRECATION: sessiondb configuration detected. Please migrate to persistence: configuration.\n";
      output += "   Run 'minsky config migrate' to automatically convert your configuration.\n\n";
    }

    // Only show separate persistence if tasks aren't using the same backend
    const innerTaskBackend = r.tasks?.backend || r.backend;
    const innerPersistenceBackend = persistenceConfig.backend || "sqlite";

    if (innerTaskBackend === "minsky" && innerPersistenceBackend === "postgres") {
      // Both using same database - don't duplicate
      output += "💾 Persistence:\n   • All data stored in PostgreSQL database\n";
    } else {
      output += "💾 Persistence:\n";
      output += `   • Backend: ${getSessionBackendDisplayName(innerPersistenceBackend)}\n`;
    }

    if (innerPersistenceBackend === "sqlite" && persistenceConfig.sqlite?.dbPath) {
      output += `   • Database: ${persistenceConfig.sqlite.dbPath}\n`;
    } else if (
      innerPersistenceBackend === "postgres" &&
      persistenceConfig.postgres?.connectionString
    ) {
      output += "   • Connection: configured\n";
    }
  }

  // AI Configuration
  if (aiProvidersMap && Object.keys(aiProvidersMap).length > 0) {
    output += "🤖 AI Configuration:\n";

    if (r.ai?.defaultProvider) {
      output += `   • Default Provider: ${r.ai.defaultProvider}\n`;
    }

    output += "   • Configured Providers:\n";
    for (const [provider, config] of Object.entries(aiProvidersMap)) {
      if (config && typeof config === "object") {
        const providerConfig = config as Record<string, unknown>;
        output += `     ${provider}:`;

        const details: string[] = [];
        if (providerConfig.model) {
          details.push(`model: ${providerConfig.model}`);
        }
        if (providerConfig.enabled !== undefined) {
          details.push(`enabled: ${providerConfig.enabled ? "yes" : "no"}`);
        }
        if (providerConfig.apiKey) {
          details.push("authenticated");
        }

        if (details.length > 0) {
          output += ` ${details.join(", ")}\n`;
        } else {
          output += "\n";
        }
      }
    }
  }

  // GitHub Configuration
  if (r.github && Object.keys(r.github).length > 0) {
    output += "🐙 GitHub Configuration:\n";

    if (r.github.token) {
      output += "   • Token: configured\n";
    }
    if (r.github.organization) {
      output += `   • Organization: ${r.github.organization}\n`;
    }
    if (r.github.baseUrl && r.github.baseUrl !== "https://api.github.com") {
      output += `   • Base URL: ${r.github.baseUrl}\n`;
    }
  }

  // Logger Configuration (show if non-default or has interesting settings)
  if (r.logger) {
    const logger = r.logger;
    const hasNonDefaultSettings =
      logger.mode !== "auto" ||
      logger.level !== "info" ||
      logger.enableAgentLogs === true ||
      logger.logFile ||
      logger.includeTimestamp === false ||
      logger.includeLevel === false;

    if (hasNonDefaultSettings) {
      output += "📊 Logger Configuration:\n";

      if (logger.mode && logger.mode !== "auto") {
        output += `   • Mode: ${logger.mode}\n`;
      }

      if (logger.level && logger.level !== "info") {
        output += `   • Level: ${logger.level}\n`;
      }

      if (logger.enableAgentLogs === true) {
        output += "   • Agent Logs: enabled\n";
      }

      if (logger.logFile) {
        output += `   • Log File: ${logger.logFile}\n`;
      }

      // Show other notable settings
      const otherSettings: string[] = [];
      if (logger.includeTimestamp === false) otherSettings.push("no timestamps");
      if (logger.includeLevel === false) otherSettings.push("no levels");
      if (logger.maxFileSize) otherSettings.push(`max file: ${logger.maxFileSize}MB`);
      if (logger.maxFiles) otherSettings.push(`max files: ${logger.maxFiles}`);

      if (otherSettings.length > 0) {
        output += `   • Other: ${otherSettings.join(", ")}\n`;
      }
    }
  }

  // Backend-specific Configuration (only show if configured)
  if (r.backendConfig && Object.keys(r.backendConfig).length > 0) {
    const hasNonEmptyBackends = Object.entries(r.backendConfig).some(
      ([, config]) =>
        config && typeof config === "object" && Object.keys(config as object).length > 0
    );

    if (hasNonEmptyBackends) {
      output += "⚙️  Backend Configuration:\n";

      for (const [backend, config] of Object.entries(r.backendConfig)) {
        if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
          output += `   • ${backend}:\n`;
          for (const [key, value] of Object.entries(config as object)) {
            output += `     ${key}: ${value}\n`;
          }
        }
      }
    }
  }

  return output.trim();
}
