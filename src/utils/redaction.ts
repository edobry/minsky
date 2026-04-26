/**
 * Redaction utilities for sensitive data in logs and diagnostics.
 *
 * Provides a single source of truth for which keys are considered sensitive,
 * and a recursive redact() function that replaces their values before logging.
 */

/**
 * Case-insensitive substring patterns that identify sensitive keys.
 *
 * Design rationale (mt#1181):
 *   - The bare "key" substring was removed because it matched benign keys like
 *     `monkey`, `keyboard`, `keyPath`, `surveyKeyPath`.
 *   - Credential-type *Key / *_key compound words are listed explicitly so that
 *     `apiKey`, `privateKey`, `access_key`, etc. are still caught.
 *   - The snake_case catch-all (`_key` suffix) is handled separately in
 *     SENSITIVE_KEY_REGEX rather than in this list to avoid substring pollution.
 *
 * NOTE: Both isSensitiveKey (here) and isSensitivePath in
 * src/adapters/shared/commands/config/helpers.ts share SENSITIVE_KEY_REGEX and
 * MUST use the same case-insensitive matching semantics.
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "token",
  "password",
  "secret",
  "authorization",
  "credential",
  "connectionString",
  // Explicit camelCase credential-key compound words:
  "apiKey",
  "secretKey",
  "privateKey",
  "accessKey",
  "authKey",
  "signingKey",
  "encryptionKey",
  // Explicit snake_case credential-key compound words:
  "private_key",
  "access_key",
  "auth_key",
  "signing_key",
  "encryption_key",
  "api_key",
  "secret_key",
];

/**
 * Regex that identifies a sensitive key name after lowercasing the input.
 *
 * Matches if the lowercase key:
 *   1. Is in SENSITIVE_KEY_PATTERNS (substring match), OR
 *   2. Ends with "_key" — catches arbitrary snake_case credential keys
 *      (e.g. "refresh_key", "master_key") without a false positive on
 *      "monkey" (no underscore before "key").
 *
 * Does NOT match:
 *   - "monkey"    — ends with "key" but no underscore; not in the explicit list
 *   - "keyboard"  — "key" is a prefix, not a suffix
 *   - "keyPath"   — lowercased to "keypath"; not in list, no "_key" suffix
 *   - "surveyKeyPath" — same reasoning
 *
 * Exported so that isSensitivePath in helpers.ts can share identical semantics.
 */
export const SENSITIVE_KEY_REGEX: RegExp = new RegExp(
  // Patterns from SENSITIVE_KEY_PATTERNS, lowercased for the regex
  `${
    SENSITIVE_KEY_PATTERNS.map((p) => p.toLowerCase()).join("|")
    // Plus generic snake_case suffix
  }|_key$`
  // No flags needed — isSensitiveKey always lowercases before calling .test()
);

/**
 * Returns true if the given key name is considered sensitive (case-insensitive).
 *
 * Uses SENSITIVE_KEY_REGEX for precise matching. isSensitivePath in
 * src/adapters/shared/commands/config/helpers.ts uses the same regex so that
 * both functions share identical semantics.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_REGEX.test(key.toLowerCase());
}

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";

/**
 * Internal recursive walker that operates on unknown values.
 * Avoids repeated `as unknown` casts in the public generic overload.
 */
function redactUnknown(value: unknown, visited: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    if (visited.has(value)) {
      return CIRCULAR;
    }
    visited.add(value);
    return value.map((item: unknown) => redactUnknown(item, visited));
  }

  if (typeof value === "object") {
    if (visited.has(value as object)) {
      return CIRCULAR;
    }
    visited.add(value as object);

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = isSensitiveKey(k) ? REDACTED : redactUnknown(v, visited);
    }
    return result;
  }

  // Primitives: string, number, boolean, bigint, symbol, function — return as-is
  return value;
}

/**
 * Recursively walks plain objects and arrays, replacing values whose keys
 * match isSensitiveKey with "[REDACTED]".
 *
 * - Non-object/non-array values are returned as-is.
 * - null/undefined pass through without throwing.
 * - Does NOT mutate the input; returns a new structure.
 * - Tracks visited objects via WeakSet to handle circular references.
 */
export function redact<T>(value: T): T {
  return redactUnknown(value, new WeakSet<object>()) as T;
}
