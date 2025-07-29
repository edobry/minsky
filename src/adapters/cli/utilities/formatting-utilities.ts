/**
 * CLI Formatting Utilities
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */

/**
 * Get display name for backend type
 * @param backend Backend identifier
 * @returns Human-readable backend name
 */
export function getBackendDisplayName(backend: string): string {
  switch (backend) {
    case "markdown":
      return "Markdown files (process/tasks.md)";
    case "json-file":
      return "JSON files";
    case "github-issues":
      return "GitHub Issues";
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
  output += `📁 Task Storage: ${getBackendDisplayName(resolved.backend)}`;
  if (resolved.backend === "github-issues" && resolved.backendConfig?.["github-issues"]) {
    const github = resolved.backendConfig["github-issues"];
    output += ` (${github.owner}/${github.repo})`;
  }

  // Authentication
  if (resolved.credentials && Object.keys(resolved.credentials).length > 0) {
    output += "\n🔐 Authentication: ";
    const authServices: string[] = [];

    if (resolved.credentials.github) {
      authServices.push("GitHub (configured)");
    }

    if (resolved.credentials.ai && Object.keys(resolved.credentials.ai).length > 0) {
      const configuredProviders = Object.keys(resolved.credentials.ai);
      authServices.push(`AI (${configuredProviders.join(", ")})`);
    }

    output += authServices.join(", ");
  }

  // Session Storage
  if (resolved.sessiondb) {
    const sessionBackend = resolved.sessiondb.backend || "json";
    output += `\n💾 Session Storage: ${getSessionBackendDisplayName(sessionBackend)}`;

    if (sessionBackend === "sqlite" && resolved.sessiondb.dbPath) {
      output += ` (${resolved.sessiondb.dbPath})`;
    } else if (sessionBackend === "postgres" && resolved.sessiondb.connectionString) {
      output += " (configured)";
    } else if (sessionBackend === "json" && resolved.sessiondb.baseDir) {
      output += ` (${resolved.sessiondb.baseDir})`;
    }
  }

  // AI Configuration
  if (resolved.ai?.providers && Object.keys(resolved.ai.providers).length > 0) {
    output += "\n🤖 AI Providers: ";
    const providerDetails: string[] = [];

    if (resolved.ai.defaultProvider) {
      providerDetails.push(`default: ${resolved.ai.defaultProvider}`);
    }

    const configuredProviders: string[] = [];
    for (const [provider, config] of Object.entries(resolved.ai.providers)) {
      if (config && typeof config === "object") {
        const providerConfig = config as any;
        let providerInfo = provider;

        if (providerConfig.model) {
          providerInfo += ` (${providerConfig.model})`;
        }

        const hasApiKey = providerConfig.apiKey || resolved.credentials?.ai?.[provider];
        if (hasApiKey) {
          providerInfo += " ✓";
        }

        configuredProviders.push(providerInfo);
      }
    }

    if (configuredProviders.length > 0) {
      providerDetails.push(configuredProviders.join(", "));
    }

    output += providerDetails.join(" | ");
  }

  // GitHub Configuration
  if (resolved.github && Object.keys(resolved.github).length > 0) {
    output += "\n🐙 GitHub: ";
    const githubDetails = [];

    if (resolved.github.organization) {
      githubDetails.push(`org: ${resolved.github.organization}`);
    }

    if (resolved.github.baseUrl && resolved.github.baseUrl !== "https://api.github.com") {
      githubDetails.push(`custom URL`);
    }

    if (resolved.credentials?.github) {
      githubDetails.push("authenticated");
    }

    output += githubDetails.length > 0 ? githubDetails.join(", ") : "configured";
  }

  // Logger Configuration (only show if non-default)
  if (resolved.logger) {
    const logger = resolved.logger;
    const hasNonDefaultSettings =
      logger.mode !== "auto" ||
      logger.level !== "info" ||
      logger.enableAgentLogs === true ||
      logger.logFile;

    if (hasNonDefaultSettings) {
      output += "\n📊 Logger: ";
      const loggerDetails = [];

      if (logger.mode && logger.mode !== "auto") {
        loggerDetails.push(`mode: ${logger.mode}`);
      }

      if (logger.level && logger.level !== "info") {
        loggerDetails.push(`level: ${logger.level}`);
      }

      if (logger.enableAgentLogs === true) {
        loggerDetails.push("agent logs enabled");
      }

      if (logger.logFile) {
        loggerDetails.push(`file: ${logger.logFile}`);
      }

      output += loggerDetails.join(", ");
    }
  }

  // Backend-specific Configuration (only show if configured)
  if (resolved.backendConfig && Object.keys(resolved.backendConfig).length > 0) {
    const hasNonEmptyBackends = Object.entries(resolved.backendConfig).some(
      ([, config]) =>
        config && typeof config === "object" && Object.keys(config as object).length > 0
    );

    if (hasNonEmptyBackends) {
      output += "\n⚙️  Backend Config: ";
      const backendDetails = [];

      for (const [backend, config] of Object.entries(resolved.backendConfig)) {
        if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
          const details = Object.entries(config as object).map(([key, value]) => `${key}=${value}`);
          backendDetails.push(`${backend} (${details.join(", ")})`);
        }
      }

      output += backendDetails.join(" | ");
    }
  }

  return output;
}
