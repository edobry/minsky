/**
 * Redaction utilities for sensitive data in logs and diagnostics.
 *
 * Provides a single source of truth for which keys are considered sensitive,
 * and a recursive redact() function that replaces their values before logging.
 */

/**
 * Case-insensitive patterns that identify sensitive keys.
 *
 * Design rationale (mt#1181 / R4 Findings A+B):
 *   - Generic English words ("token", "password", "secret", "connectionString")
 *     are matched only as whole words/segments, NOT as substrings. This prevents
 *     false positives like `secretary` (contains "secret"), `tokenize` (contains
 *     "token"). `passwordHash` intentionally does NOT match — it is metadata,
 *     not a credential value.
 *   - Credential-type *Key / *_key compound words are listed explicitly so that
 *     `apiKey`, `privateKey`, `access_key`, etc. are still caught.
 *   - The catch-all (`[-_]key` suffix) is handled in SENSITIVE_KEY_REGEX to
 *     catch `refresh_key`, `refresh-key`, etc. without false positives on
 *     `monkey` or `keyboard`.
 *   - "authorization" and "credential" are intentionally absent as bare
 *     substring patterns because they over-match benign keys such as
 *     `authorizationMode`, `credentialStatus`, `authorizationLevel`. They are
 *     instead anchored as whole-word/segment matches in SENSITIVE_KEY_REGEX.
 *   - Hyphenated HTTP-header style keys (`x-api-key`, `x-auth-token`,
 *     `proxy-authorization`) are supported natively in the regex; `-` and `_`
 *     are treated as equivalent separators. No input normalization is performed.
 *
 * NOTE: Both isSensitiveKey (here) and isSensitivePath in
 * src/adapters/shared/commands/config/helpers.ts share SENSITIVE_KEY_REGEX and
 * MUST use the same case-insensitive matching semantics.
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  // Generic credential words — matched as whole segments only (see SENSITIVE_KEY_REGEX).
  // passwordHash intentionally does NOT match (metadata, not a credential value).
  "token",
  "password",
  "secret",
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

// Generic words that require whole-segment matching to prevent substring false positives.
// After lowercasing, matched via `(?:^|[-_a-z])WORD$`:
//   - exact:          "token"          -> matches
//   - separator:      "x-auth-token"   -> "-" before "token" -> matches
//   - camelCase:      "accessToken"    lowercased "accesstoken", "n" precedes "token" -> matches
// Non-matches:
//   - "tokenize"      -> ends with "tokenize", not "token"
//   - "secretary"     -> ends with "secretary", not "secret"
//   - "passwordHash"  -> ends with "passwordhash" (metadata, not a credential)
const GENERIC_WORDS = ["token", "password", "secret", "connectionstring"];

// Compound camelCase terms lowercased. Specific enough that exact-or-suffix matching is safe.
const COMPOUND_CAMEL = [
  "apikey",
  "secretkey",
  "privatekey",
  "accesskey",
  "authkey",
  "signingkey",
  "encryptionkey",
];

// Compound separator terms with [-_] to match both snake_case and kebab-case.
// e.g. "api[-_]key" matches "api_key" and "api-key" (so "x-api-key" is caught natively).
const COMPOUND_SEP = [
  "private[-_]key",
  "access[-_]key",
  "auth[-_]key",
  "signing[-_]key",
  "encryption[-_]key",
  "api[-_]key",
  "secret[-_]key",
];

// Authorization variants — whole-segment anchored; "authorizationmode" is NOT matched.
const AUTH_VARIANTS = ["authorization", "authorizationheader"];

// Credential variants — whole-segment anchored; "credentialstatus" is NOT matched.
const CRED_VARIANTS = ["credential", "credentials", "credentialstring"];

/**
 * Regex that identifies a sensitive key name after lowercasing the input.
 *
 * Matching rules (applied after `key.toLowerCase()`):
 *   1. Generic words ("token", "password", "secret", "connectionstring"):
 *      matched only when the word is an exact key OR a whole trailing segment,
 *      i.e. preceded by `^`, `[-_]`, or a lowercase letter (camelCase boundary).
 *      Prevents `secretary`, `tokenize`, `passwordHash` from matching.
 *   2. Compound credential terms ("apiKey", "api_key", etc.): matched as exact
 *      key or as a trailing segment. `[-_]` accepts either `-` or `_` so that
 *      `x-api-key`, `x-auth-token`, `proxy-authorization` are caught natively
 *      without any input normalization.
 *   3. Catch-all: `[-_]key$` — catches `refresh_key`, `refresh-key`, etc.
 *      The separator before "key" prevents false positives on `monkey`.
 *   4. Authorization variants ("authorization", "authorizationheader"):
 *      whole segment only; `authorizationMode` is NOT matched.
 *   5. Credential variants ("credential", "credentials", "credentialstring"):
 *      whole segment only; `credentialStatus` is NOT matched.
 *
 * Does NOT match:
 *   - "monkey"             — ends with "key" but no separator; not in explicit list
 *   - "keyboard"           — "key" is a prefix, not a suffix
 *   - "keyPath"            — lowercased to "keypath"; no [-_]key suffix
 *   - "surveyKeyPath"      — same reasoning
 *   - "secretary"          — ends with "secretary", not "secret"
 *   - "tokenize"           — ends with "tokenize", not "token"
 *   - "passwordHash"       — metadata field; ends with "passwordhash", not "password"
 *   - "authorizationMode"  — lowercased to "authorizationmode"; not a whole segment
 *   - "credentialStatus"   — lowercased to "credentialstatus"; not a whole segment
 *
 * Exported so that isSensitivePath in helpers.ts can share identical semantics.
 */
export const SENSITIVE_KEY_REGEX: RegExp = new RegExp(
  [
    // Generic words: whole-segment match only (exact, separator, or camelCase prefix)
    ...GENERIC_WORDS.map((w) => `(?:^|[-_a-z])${w}$`),
    // Compound camelCase terms: exact-or-suffix
    ...COMPOUND_CAMEL.map((t) => `(?:^|[-_a-z])${t}$`),
    // Compound separator terms with [-_] support: exact-or-suffix
    ...COMPOUND_SEP.map((t) => `(?:^|[-_a-z])${t}$`),
    // Generic catch-all: any key ending with [-_]key (separator required before "key")
    "[-_]key$",
    // Authorization variants: whole segment only
    ...AUTH_VARIANTS.map((v) => `(?:^|[-_a-z])${v}$`),
    // Credential variants: whole segment only
    ...CRED_VARIANTS.map((v) => `(?:^|[-_a-z])${v}$`),
  ].join("|")
  // No flags needed — isSensitiveKey always lowercases before calling .test()
);

/**
 * Returns true if the given key name is considered sensitive (case-insensitive).
 *
 * Uses SENSITIVE_KEY_REGEX for precise matching. isSensitivePath in
 * src/adapters/shared/commands/config/helpers.ts uses the same regex so that
 * both functions share identical semantics.
 *
 * No input normalization is performed — the regex natively accepts both `-` and
 * `_` separators (e.g. `x-api-key` and `x_api_key` both match).
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
