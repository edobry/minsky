/**
 * Redaction utilities for sensitive data in logs and diagnostics.
 *
 * Provides a single source of truth for which keys are considered sensitive,
 * and a recursive redact() function that replaces their values before logging.
 */

/**
 * Substring patterns used to identify sensitive keys.
 * Case-insensitive substring match — any key whose name contains one of these
 * strings is considered sensitive.
 *
 * Mirrors the set used in src/adapters/shared/commands/config/helpers.ts
 * (isSensitivePath) so there is a single source of truth.
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "token",
  "apiKey",
  "password",
  "secret",
  "key",
  "connectionString",
];

/**
 * Returns true if the given key name contains any of the sensitive patterns
 * (case-insensitive substring match).
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
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
