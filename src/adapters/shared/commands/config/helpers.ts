/**
 * Config Command Helpers
 *
 * Shared utilities for the config command sub-modules:
 * credential masking, value parsing, and credential info gathering.
 */

import { DefaultCredentialResolver } from "../../../../domain/configuration/credential-resolver";
import { isSensitiveKey } from "../../../../utils/redaction";

/**
 * Recursively masks sensitive values in a plain config object using
 * isSensitiveKey — the same function used by isSensitivePath in this file and
 * the standalone isSensitiveKey export in redaction.ts. Both share identical
 * matching semantics including hyphen normalization (mt#1181 Finding 2).
 *
 * @param value  Any config value (object, array, or primitive)
 * @returns      A new value with sensitive keys replaced by the masked sentinel
 */
function maskConfigValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(maskConfigValue);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && v !== null && v !== undefined) {
        result[k] = typeof v === "string" ? `${"*".repeat(20)} (configured)` : "[MASKED]";
      } else {
        result[k] = maskConfigValue(v);
      }
    }
    return result;
  }
  return value;
}

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
    // Deep-clone so callers that mutate the returned object do not corrupt the
    // original config reference (mt#1181 Finding 1 — mutation hazard).
    return structuredClone(config);
  }

  return maskConfigValue(config) as Record<string, unknown>;
}

export function maskCredentialsInEffectiveValues(
  effectiveValues: Record<string, { value: unknown; source: string; path: string }>,
  showSecrets: boolean
): Record<string, { value: unknown; source: string; path: string }> {
  if (showSecrets) {
    return effectiveValues;
  }

  const masked: Record<string, { value: unknown; source: string; path: string }> = {};

  // Helper to check if a path contains sensitive information.
  // Delegates to isSensitiveKey (redaction.ts) so that both share identical
  // matching semantics — same regex, same hyphen normalization — for paths like
  // "github.Token", "ai.providers.OpenAI.apiKEY", "SESSIONDB.ConnectionString",
  // and hyphenated segments like "headers.x-api-key" (mt#1181 Finding 2).
  const isSensitivePath = (path: string): boolean => {
    // Test each dot-separated segment so that only the actual key part is
    // matched (e.g. "providers" in "ai.providers.openai.apiKey" is not
    // flagged, but "apiKey" is).
    return path.split(".").some((segment) => isSensitiveKey(segment));
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
