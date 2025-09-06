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
 * Format configuration sources for display
 * @param resolved Resolved configuration
 * @param sources Configuration sources
 * @returns Formatted sources string
 */
export function formatConfigurationSources(resolved: any, sources: any[]): string {
  let output = "📋 CONFIGURATION SOURCES\n";
  output += "========================================\n";

  // Show source precedence
  output += "Source Precedence (highest to lowest):\n";
  sources.forEach((source, index) => {
    output += `  ${index + 1}. ${source.name}\n`;
  });

  output += "\n📋 RESOLVED CONFIGURATION\n";
  output += formatResolvedConfiguration(resolved);

  output += "\n\n💡 For just the final configuration, use: minsky config show";

  return output;
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
  if (taskBackend) {
    output += `📁 Task Storage: ${getBackendDisplayName(taskBackend)}`;
  } else {
    output += `📁 Task Storage: Auto-detected (multi-backend mode)`;
  }
  if (taskBackend === TaskBackend.GITHUB_ISSUES && resolved.backendConfig?.["github-issues"]) {
    const github = resolved.backendConfig["github-issues"];
    output += ` (${github.owner}/${github.repo})`;
  }
  output += "\n";

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

  // Persistence Storage (unified for sessions, tasks, embeddings)
  const persistenceConfig = resolved.persistence || resolved.sessiondb; // fallback to legacy
  if (persistenceConfig) {
    // Warn about legacy sessiondb usage
    if (!resolved.persistence && resolved.sessiondb) {
      output +=
        "⚠️  DEPRECATION: sessiondb configuration detected. Please migrate to persistence: configuration.\n";
      output += "   Run 'minsky config migrate' to automatically convert your configuration.\n\n";
    }
    output += "💾 Persistence Storage:\n";
    const persistenceBackend = persistenceConfig.backend || "sqlite";
    output += `   • Backend: ${getSessionBackendDisplayName(persistenceBackend)}\n`;

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
