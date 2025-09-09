/**
 * CLI Formatting Utilities
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */

import { TaskBackend } from "../../../domain/configuration/backend-detection";

/**
 * Get display name for backend type
 * @param backend Backend identifier
 * @returns Human-readable backend name
 */
export function getBackendDisplayName(backend: string): string {
  switch (backend) {
    case TaskBackend.MARKDOWN:
      return "Markdown files (process/tasks.md)";
    case TaskBackend.JSON_FILE:
      return "JSON files";
    case TaskBackend.GITHUB_ISSUES:
      return "GitHub Issues";
    case TaskBackend.MINSKY:
      return "Minsky database";
    default:
      return backend;
  }
}

/**
 * Get display name for session backend type
 * @param backend Session backend identifier
 * @returns Human-readable session backend name
 */
export function getSessionBackendDisplayName(backend: string): string {
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

/**
 * Format detection condition for display
 * @param condition Detection condition identifier
 * @returns Human-readable condition description
 */
export function formatDetectionCondition(condition: string): string {
  switch (condition) {
    case "tasks_md_exists":
      return "If process/tasks.md exists";
    case "json_file_exists":
      return "If JSON task files exist";
    case "always":
      return "As default fallback";
    default:
      return condition;
  }
}

/**
 * Sanitize credentials for display
 * @param creds Credentials object
 * @returns Sanitized credentials object
 */
export function sanitizeCredentials(creds: any): any {
  if (!creds || typeof creds !== "object") {
    return creds;
  }

  const sanitized = { ...creds };
  if (sanitized.token) {
    sanitized.token = `${"*".repeat(20)} (hidden)`;
  }

  return sanitized;
}

/**
 * Format configuration section for display
 * @param config Configuration object
 * @returns Formatted configuration string
 */
export function formatConfigSection(config: any): string {
  if (!config || Object.keys(config as any).length === 0) {
    return "  (empty)";
  }

  let output = "";
  for (const [key, value] of Object.entries(config as any)) {
    if (Array.isArray(value)) {
      output += `  ${key}: (${(value as any[]).length} items)\n`;
      (value as any[]).forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          output += `    ${index}: ${JSON.stringify(item)}\n`;
        } else {
          output += `    ${index}: ${item}\n`;
        }
      });
    } else if (typeof value === "object" && value !== null) {
      output += `  ${key}:\n`;
      for (const [subKey, subValue] of Object.entries(value as any)) {
        if (typeof subValue === "object" && subValue !== null) {
          // Special handling for credentials
          if (key === "credentials") {
            const sanitized = sanitizeCredentials(subValue);
            output += `    ${subKey}: ${JSON.stringify(sanitized)}\n`;
          } else {
            output += `    ${subKey}: ${JSON.stringify(subValue)}\n`;
          }
        } else {
          output += `    ${subKey}: ${subValue}\n`;
        }
      }
    } else {
      output += `  ${key}: ${value}\n`;
    }
  }

  return output.trimEnd();
}

/**
 * Format configuration sources for display (enhanced pretty format with source info)
 * @param resolved Resolved configuration
 * @param sources Configuration sources
 * @param effectiveValues Per-value source information
 * @returns Formatted sources string
 */
export function formatConfigurationSources(
  resolved: any,
  sources: any[],
  effectiveValues?: Record<string, { value: any; source: string; path: string }>
): string {
  let output = "📋 CONFIGURATION WITH SOURCES\n";
  output += "========================================\n";

  // Show source precedence
  output += "Source Precedence (highest to lowest):\n";
  sources.forEach((source, index) => {
    let sourceLine = `  ${index + 1}. ${source.name}`;
    if (source.path) {
      sourceLine += ` (${source.path})`;
    }
    output += `${sourceLine}\n`;
  });

  output += "\n";

  // Show enhanced configuration with source annotations
  if (effectiveValues) {
    output += formatResolvedConfigurationWithSources(resolved, effectiveValues);
  } else {
    output += formatResolvedConfiguration(resolved);
  }

  output += "\n\n💡 For per-value source details, use: minsky config list --sources";

  return output;
}

/**
 * Format individual configuration values with their sources
 * @param effectiveValues Map of configuration paths to value and source info
 * @param sources Configuration sources metadata
 * @returns Formatted string showing each value with its source
 */
export function formatEffectiveValueSources(
  effectiveValues: Record<string, { value: any; source: string; path: string }>,
  sources: any[]
): string {
  let output = "📋 CONFIGURATION VALUES BY SOURCE\n";
  output += "========================================\n";

  // Show source precedence first
  output += "Source Precedence (highest to lowest):\n";
  sources.forEach((source, index) => {
    output += `  ${index + 1}. ${source.name}\n`;
  });
  output += "\n";

  // Sort paths for consistent display
  const sortedPaths = Object.keys(effectiveValues).sort();

  // Group values by source for easier reading
  const valuesBySource: Record<string, Array<{ path: string; value: any }>> = {};

  for (const path of sortedPaths) {
    const valueInfo = effectiveValues[path];
    if (!valuesBySource[valueInfo.source]) {
      valuesBySource[valueInfo.source] = [];
    }
    valuesBySource[valueInfo.source].push({
      path,
      value: valueInfo.value,
    });
  }

  // Display values grouped by source
  for (const sourceObj of sources) {
    const sourceName = sourceObj.name;
    const values = valuesBySource[sourceName];
    if (values && values.length > 0) {
      // Show the source name and path if available
      let sourceHeader = `📂 FROM ${sourceName.toUpperCase()}`;
      if (sourceObj.path) {
        sourceHeader += ` (${sourceObj.path})`;
      }
      output += `${sourceHeader}:\n`;

      for (const { path, value } of values) {
        const displayValue = formatValueForDisplay(value);
        output += `   ${path}=${displayValue}\n`;
      }
      output += "\n";
    }
  }

  output += "💡 For flattened key=value pairs, use: minsky config list\n";
  output += "💡 For formatted configuration overview, use: minsky config show";

  return output;
}

/**
 * Format a configuration value for display
 */
function formatValueForDisplay(value: any): string {
  if (value === null) return "(null)";
  if (value === undefined) return "(undefined)";
  if (Array.isArray(value)) {
    return value.length === 0 ? "(empty array)" : `(${value.length} items)`;
  }
  if (typeof value === "object") return `{${Object.keys(value).length} properties}`;
  // For strings, numbers, booleans - display as-is (they're already masked if sensitive)
  return String(value);
}

/**
 * Format resolved configuration with source annotations
 * @param resolved Resolved configuration object
 * @param effectiveValues Per-value source information
 * @returns Enhanced formatted configuration string with sources
 */
export function formatResolvedConfigurationWithSources(
  resolved: any,
  effectiveValues: Record<string, { value: any; source: string; path: string }>
): string {
  // Helper to get source annotation for a config path
  const getSourceAnnotation = (path: string): string => {
    const valueInfo = effectiveValues[path];
    if (valueInfo) {
      return ` [${valueInfo.source}]`;
    }
    return "";
  };

  let output = "📋 CURRENT CONFIGURATION\n";

  // Task Storage
  const taskBackend = resolved.tasks?.backend || resolved.backend;
  const persistenceConfig = resolved.persistence || resolved.sessiondb;
  const persistenceBackend = persistenceConfig?.backend || "sqlite";

  // Don't show separate task storage if it's using the same database as persistence
  if (taskBackend === "minsky" && persistenceBackend === "postgres") {
    // Will be shown in unified database section below
  } else if (taskBackend) {
    const taskBackendSource =
      getSourceAnnotation("tasks.backend") || getSourceAnnotation("backend");
    output += `📁 Task Storage: ${getBackendDisplayName(taskBackend)}${taskBackendSource}`;
    if (taskBackend === "github-issues" && resolved.backendConfig?.["github-issues"]) {
      const github = resolved.backendConfig["github-issues"];
      output += ` (${github.owner}/${github.repo})`;
    }
    output += "\n";
  } else {
    output += `📁 Task Storage: Auto-detected (multi-backend mode)\n`;
  }

  // Authentication & Credentials
  const hasAuth =
    (resolved.credentials && Object.keys(resolved.credentials).length > 0) ||
    resolved.github?.token ||
    (resolved.ai?.providers &&
      Object.keys(resolved.ai.providers).some((p) => resolved.ai.providers[p]?.apiKey));

  if (hasAuth) {
    output += "🔐 Authentication:\n";

    // GitHub authentication
    if (resolved.github?.token || resolved.credentials?.github) {
      const githubSource = getSourceAnnotation("github.token");
      output += `   • GitHub: ✓ configured${githubSource}\n`;
    }

    // AI provider authentication
    if (resolved.ai?.providers) {
      const configuredAI: string[] = [];
      const aiSources: string[] = [];
      for (const [provider, config] of Object.entries(resolved.ai.providers)) {
        if (config && typeof config === "object") {
          const providerConfig = config as any;
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
  if (resolved.ai?.providers && Object.keys(resolved.ai.providers).length > 0) {
    output += "🤖 AI Configuration:\n";

    if (resolved.ai.defaultProvider) {
      const defaultSource = getSourceAnnotation("ai.defaultProvider");
      output += `   • Default Provider: ${resolved.ai.defaultProvider}${defaultSource}\n`;
    }

    output += "   • Configured Providers:\n";
    for (const [provider, config] of Object.entries(resolved.ai.providers)) {
      if (config && typeof config === "object") {
        const providerConfig = config as any;
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
  if (resolved.github && Object.keys(resolved.github).length > 0) {
    output += "🐙 GitHub Configuration:\n";

    if (resolved.github.token) {
      const tokenSource = getSourceAnnotation("github.token");
      output += `   • Token: configured${tokenSource}\n`;
    }
    if (resolved.github.organization) {
      const orgSource = getSourceAnnotation("github.organization");
      output += `   • Organization: ${resolved.github.organization}${orgSource}\n`;
    }
    if (resolved.github.baseUrl && resolved.github.baseUrl !== "https://api.github.com") {
      const urlSource = getSourceAnnotation("github.baseUrl");
      output += `   • Base URL: ${resolved.github.baseUrl}${urlSource}\n`;
    }
  }

  return output.trim();
}

/**
 * Format resolved configuration for display
 * @param resolved Resolved configuration object
 * @returns Formatted configuration string
 */
export function formatResolvedConfiguration(resolved: any): string {
  let output = "📋 CURRENT CONFIGURATION\n";

  // Task Storage
  // Note: tasks.backend is preferred, root backend is deprecated but kept for compatibility
  const taskBackend = resolved.tasks?.backend || resolved.backend;
  const persistenceConfig = resolved.persistence || resolved.sessiondb;
  const persistenceBackend = persistenceConfig?.backend || "sqlite";

  // Don't show separate task storage if it's using the same database as persistence
  if (taskBackend === "minsky" && persistenceBackend === "postgres") {
    // Will be shown in unified database section below
  } else if (taskBackend) {
    output += `📁 Task Storage: ${getBackendDisplayName(taskBackend)}`;
    if (taskBackend === TaskBackend.GITHUB_ISSUES && resolved.backendConfig?.["github-issues"]) {
      const github = resolved.backendConfig["github-issues"];
      output += ` (${github.owner}/${github.repo})`;
    }
    output += "\n";
  } else {
    output += `📁 Task Storage: Auto-detected (multi-backend mode)\n`;
  }

  // Authentication & Credentials
  const hasAuth =
    (resolved.credentials && Object.keys(resolved.credentials).length > 0) ||
    resolved.github?.token ||
    (resolved.ai?.providers &&
      Object.keys(resolved.ai.providers).some((p) => resolved.ai.providers[p]?.apiKey));

  if (hasAuth) {
    output += "🔐 Authentication:\n";

    // GitHub authentication
    if (resolved.github?.token || resolved.credentials?.github) {
      output += "   • GitHub: ✓ configured\n";
    }

    // AI provider authentication
    if (resolved.ai?.providers) {
      const configuredAI: string[] = [];
      for (const [provider, config] of Object.entries(resolved.ai.providers)) {
        if (config && typeof config === "object") {
          const providerConfig = config as any;
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
    if (!resolved.persistence && resolved.sessiondb) {
      output +=
        "⚠️  DEPRECATION: sessiondb configuration detected. Please migrate to persistence: configuration.\n";
      output += "   Run 'minsky config migrate' to automatically convert your configuration.\n\n";
    }

    // Only show separate persistence if tasks aren't using the same backend
    const taskBackend = resolved.tasks?.backend || resolved.backend;
    const persistenceBackend = persistenceConfig.backend || "sqlite";

    if (taskBackend === "minsky" && persistenceBackend === "postgres") {
      // Both using same database - don't duplicate
      output += "💾 Persistence:\n   • All data stored in PostgreSQL database\n";
    } else {
      output += "💾 Persistence:\n";
      output += `   • Backend: ${getSessionBackendDisplayName(persistenceBackend)}\n`;
    }

    if (persistenceBackend === "sqlite" && persistenceConfig.sqlite?.dbPath) {
      output += `   • Database: ${persistenceConfig.sqlite.dbPath}\n`;
    } else if (persistenceBackend === "postgres" && persistenceConfig.postgres?.connectionString) {
      output += "   • Connection: configured\n";
    }
  }

  // AI Configuration
  if (resolved.ai?.providers && Object.keys(resolved.ai.providers).length > 0) {
    output += "🤖 AI Configuration:\n";

    if (resolved.ai.defaultProvider) {
      output += `   • Default Provider: ${resolved.ai.defaultProvider}\n`;
    }

    output += "   • Configured Providers:\n";
    for (const [provider, config] of Object.entries(resolved.ai.providers)) {
      if (config && typeof config === "object") {
        const providerConfig = config as any;
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
  if (resolved.github && Object.keys(resolved.github).length > 0) {
    output += "🐙 GitHub Configuration:\n";

    if (resolved.github.token) {
      output += "   • Token: configured\n";
    }
    if (resolved.github.organization) {
      output += `   • Organization: ${resolved.github.organization}\n`;
    }
    if (resolved.github.baseUrl && resolved.github.baseUrl !== "https://api.github.com") {
      output += `   • Base URL: ${resolved.github.baseUrl}\n`;
    }
  }

  // Logger Configuration (show if non-default or has interesting settings)
  if (resolved.logger) {
    const logger = resolved.logger;
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
  if (resolved.backendConfig && Object.keys(resolved.backendConfig).length > 0) {
    const hasNonEmptyBackends = Object.entries(resolved.backendConfig).some(
      ([, config]) =>
        config && typeof config === "object" && Object.keys(config as object).length > 0
    );

    if (hasNonEmptyBackends) {
      output += "⚙️  Backend Configuration:\n";

      for (const [backend, config] of Object.entries(resolved.backendConfig)) {
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
