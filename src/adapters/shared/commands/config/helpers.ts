/**
 * Config Command Helpers
 *
 * Shared utilities for the config command sub-modules:
 * credential masking, value parsing, and credential info gathering.
 */

import { DefaultCredentialResolver } from "@minsky/domain/configuration/credential-resolver";
import { isSensitiveKey } from "../../../../utils/redaction";

/**
 * Recursively masks sensitive values in a plain config object using
 * isSensitiveKey — the same function used by isSensitivePath in this file and
 * the standalone isSensitiveKey export in redaction.ts. Both share identical
 * matching semantics including hyphen normalization (mt#1181 Finding 2).
 *
 * Exported (mt#3634) so `maskCredentialsInEffectiveValues` masks by the SAME
 * value traversal instead of a second, path-only heuristic. Two independent
 * maskers over the same data is what let them diverge: this one recursed into
 * values and the other did not, so a credential nested inside a composite
 * effective-value was emitted in plaintext.
 *
 * @param value  Any config value (object, array, or primitive)
 * @returns      A new value with sensitive keys replaced by the masked sentinel
 */
export function maskConfigValue(value: unknown): unknown {
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
    // Uses JSON-clone (matching the pre-refactor behavior) instead of
    // structuredClone, which throws DataCloneError on functions, class
    // instances, or unsupported value types (R5 finding).
    return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  }

  return maskConfigValue(config) as Record<string, unknown>;
}

/** The sentinel a masked string value is replaced with. */
const MASKED_STRING_SENTINEL = `${"*".repeat(20)} (configured)`;

/**
 * True when any dot-separated segment of `path` names a credential.
 *
 * Tests each segment so only the actual key part matches — "providers" in
 * "ai.providers.openai.apiKey" is not flagged, but "apiKey" is. Delegates to
 * `isSensitiveKey` so path- and value-based masking share one predicate,
 * including its hyphen normalization (mt#1181 Finding 2).
 */
export function isSensitiveConfigPath(path: string): boolean {
  return path.split(".").some((segment) => isSensitiveKey(segment));
}

/**
 * Mask a single configuration value addressed by `path` (mt#3634).
 *
 * Both rules are needed and neither subsumes the other:
 *  - a SENSITIVE PATH holding a scalar has no key to match during traversal,
 *    so it is masked wholesale;
 *  - a NON-SENSITIVE path holding a composite can still carry a credential
 *    nested inside it, so the value is traversed.
 *
 * Shared by `maskCredentialsInEffectiveValues` and `config.get` so a caller
 * cannot get one rule without the other — the split that caused the original
 * leak.
 */
export function maskValueForPath(path: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (isSensitiveConfigPath(path)) {
    // Already-masked values are left alone rather than double-masked.
    if (typeof value === "string") {
      return value.includes("*") && value.includes("(configured)") ? value : MASKED_STRING_SENTINEL;
    }
    return "[MASKED]";
  }
  return maskConfigValue(value);
}

export function maskCredentialsInEffectiveValues(
  effectiveValues: Record<string, { value: unknown; source: string; path: string }>,
  showSecrets: boolean
): Record<string, { value: unknown; source: string; path: string }> {
  if (showSecrets) {
    return effectiveValues;
  }

  const masked: Record<string, { value: unknown; source: string; path: string }> = {};

  // mt#3634: both rules come from `maskValueForPath` — a sensitive PATH masks
  // the value wholesale, and a non-sensitive path still has its VALUE
  // traversed. Previously only the first rule was applied here, so a composite
  // under a non-sensitive path (`knowledgeBases`, one non-sensitive segment)
  // was emitted verbatim including its nested `[0].auth.token`, while the
  // sibling `configuration` tree masked the very same token correctly.
  for (const [path, valueInfo] of Object.entries(effectiveValues)) {
    masked[path] = { ...valueInfo, value: maskValueForPath(path, valueInfo.value) };
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
