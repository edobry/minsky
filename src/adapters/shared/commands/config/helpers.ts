/**
 * Config Command Helpers
 *
 * Shared utilities for the config command sub-modules:
 * credential masking, value parsing, and credential info gathering.
 */

import { DefaultCredentialResolver } from "../../../../domain/configuration/credential-resolver";
import { SENSITIVE_KEY_PATTERNS } from "../../../../utils/redaction";

/**
 * Masks sensitive credential values in configuration
 * @param config Configuration object
 * @param showSecrets Whether to show actual secret values
 * @returns Configuration with credentials masked unless showSecrets is true
 */
export function maskCredentials(
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
    for (const [_provider, providerConfig] of Object.entries(
      maskedAi.providers as Record<string, unknown>
    )) {
      if (providerConfig && typeof providerConfig === "object") {
        const cfg = providerConfig as Record<string, unknown>;
        if (cfg.apiKey) {
          cfg.apiKey = `${"*".repeat(20)} (configured)`;
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

export function maskCredentialsInEffectiveValues(
  effectiveValues: Record<string, { value: unknown; source: string; path: string }>,
  showSecrets: boolean
): Record<string, { value: unknown; source: string; path: string }> {
  if (showSecrets) {
    return effectiveValues;
  }

  const masked: Record<string, { value: unknown; source: string; path: string }> = {};

  // Helper to check if a path contains sensitive information
  const isSensitivePath = (path: string): boolean => {
    return SENSITIVE_KEY_PATTERNS.some((pattern) => path.includes(pattern));
  };

  // Helper to mask value (but don't re-mask already masked values)
  const maskValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      // If it's already masked, don't re-mask it
      if (value.includes("*") && value.includes("(configured)")) {
        return value;
      }
      return `${"*".repeat(20)} (configured)`;
    }
    return "[MASKED]";
  };

  for (const [path, valueInfo] of Object.entries(effectiveValues)) {
    if (isSensitivePath(path) && valueInfo.value !== null && valueInfo.value !== undefined) {
      masked[path] = {
        ...valueInfo,
        value: maskValue(valueInfo.value),
      };
    } else {
      masked[path] = valueInfo;
    }
  }

  return masked;
}

/**
 * Helper: parse configuration value from string input
 */
export function parseConfigValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "undefined") return undefined;

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (!isNaN(num)) return num;
  }

  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      // fall through
    }
  }

  return value;
}

/**
 * Safely gather credential information for display
 */
export async function gatherCredentialInfo(
  credentialResolver: DefaultCredentialResolver,
  config: Record<string, unknown>,
  effectiveValues: Record<string, { value: unknown; source: string; path: string }>
) {
  const credentials: Record<string, unknown> = {};

  // Check GitHub credentials
  try {
    const githubToken = await credentialResolver.getCredential("github");
    if (githubToken) {
      credentials.github = {
        token: `${"*".repeat(20)} (configured)`,
        source: effectiveValues["github.token"]?.source ?? "unknown",
      };
    }
  } catch (error) {
    // Ignore credential resolution errors for display
  }

  // Check AI provider credentials
  const configAi = config.ai as Record<string, unknown> | undefined;
  if (configAi?.providers) {
    credentials.ai = {};
    for (const [provider, providerConfig] of Object.entries(
      configAi.providers as Record<string, unknown>
    )) {
      if (
        provider &&
        provider !== "undefined" &&
        providerConfig &&
        typeof providerConfig === "object"
      ) {
        const providerCfg = providerConfig as Record<string, unknown>;
        if (providerCfg.apiKey) {
          const keyPath = `ai.providers.${provider}.apiKey`;
          (credentials.ai as Record<string, unknown>)[provider] = {
            apiKey: `${"*".repeat(20)} (configured)`,
            source: effectiveValues[keyPath]?.source ?? "unknown",
          };
        }
      }
    }
  }

  return credentials;
}
