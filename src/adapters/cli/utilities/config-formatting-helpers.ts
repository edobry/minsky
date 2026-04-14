/**
 * Basic config formatting helpers for CLI display
 */

import { TaskBackend } from "../../../domain/configuration/backend-detection";

/** Shape of a resolved Minsky config object for display/formatting purposes */
export interface ResolvedConfigShape {
  tasks?: { backend?: string };
  backend?: string;
  persistence?: {
    backend?: string;
    sqlite?: { dbPath?: string };
    postgres?: { connectionString?: string };
  };
  sessiondb?: {
    backend?: string;
    sqlite?: { dbPath?: string };
    postgres?: { connectionString?: string };
  };
  backendConfig?: Record<string, Record<string, unknown>>;
  credentials?: Record<string, unknown>;
  github?: { token?: string; organization?: string; baseUrl?: string };
  ai?: {
    providers?: Record<string, Record<string, unknown>>;
    defaultProvider?: string;
  };
  logger?: {
    mode?: string;
    level?: string;
    enableAgentLogs?: boolean;
    logFile?: string;
    includeTimestamp?: boolean;
    includeLevel?: boolean;
    maxFileSize?: number;
    maxFiles?: number;
  };
}

/**
 * Get display name for backend type
 * @param backend Backend identifier
 * @returns Human-readable backend name
 */
export function getBackendDisplayName(backend: string): string {
  switch (backend) {
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
export function sanitizeCredentials(creds: Record<string, unknown>): Record<string, unknown> {
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
export function formatConfigSection(config: Record<string, unknown>): string {
  if (!config || Object.keys(config).length === 0) {
    return "  (empty)";
  }

  let output = "";
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) {
      output += `  ${key}: (${(value as unknown[]).length} items)\n`;
      (value as unknown[]).forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          output += `    ${index}: ${JSON.stringify(item)}\n`;
        } else {
          output += `    ${index}: ${item}\n`;
        }
      });
    } else if (typeof value === "object" && value !== null) {
      output += `  ${key}:\n`;
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof subValue === "object" && subValue !== null) {
          // Special handling for credentials
          if (key === "credentials") {
            const sanitized = sanitizeCredentials(subValue as Record<string, unknown>);
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
