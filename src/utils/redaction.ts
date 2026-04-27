/**
 * Redaction utilities for sensitive data in logs and diagnostics.
 *
 * Provides a single source of truth for which keys are considered sensitive,
 * and a recursive redact() function that replaces their values before logging.
 */

/**
 * Case-insensitive patterns that identify sensitive keys.
 *
 * Design rationale (mt#1181 / R4 + R5 + R6 findings):
 *   - Generic English words ("token", "password", "secret", "connectionString")
 *     are matched only as whole words/segments, NOT as substrings. R6: the
 *     [a-z]-camelCase boundary was dropped, so user-named fields like
 *     `mytoken`, `custompassword`, `dbconnectionstring` are NOT redacted.
 *     Credential-prefixed camelCase forms (e.g. `accessToken`, `bearerToken`)
 *     are matched via the explicit COMPOUND_CAMEL list instead.
 *   - Credential-type *Key compound words are listed explicitly in
 *     COMPOUND_CAMEL / COMPOUND_SEP.
 *   - There is intentionally NO bare [-_]key$ catch-all (R5 finding):
 *     `public-key`, `primary-key`, `host-key` are not credentials.
 *   - "authorization" and "credential" are anchored as whole-segment matches
 *     so `authorizationMode` and `credentialStatus` are NOT redacted.
 *   - Hyphenated HTTP-header style keys (`x-api-key`, `x-auth-token`,
 *     `proxy-authorization`) are supported natively in the regex; `-` and `_`
 *     are treated as equivalent separators. No input normalization is performed.
 *
 * NOTE: Both isSensitiveKey (here) and isSensitivePath in
 * src/adapters/shared/commands/config/helpers.ts share SENSITIVE_KEY_REGEX and
 * MUST use the same case-insensitive matching semantics.
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  "token",
  "password",
  "secret",
  "connectionString",
  "apiKey",
  "secretKey",
  "privateKey",
  "accessKey",
  "authKey",
  "signingKey",
  "encryptionKey",
  "private_key",
  "access_key",
  "auth_key",
  "signing_key",
  "encryption_key",
  "api_key",
  "secret_key",
];

// Generic words: matched only as exact key OR after separator. R6 finding —
// the previous [a-z]-camelCase boundary over-redacted fields like `mytoken`,
// `custompassword`, `dbconnectionstring` after lowercasing destroyed the
// camelCase signal. Credential-prefixed camelCase tokens are enumerated in
// COMPOUND_CAMEL below.
const GENERIC_WORDS = ["token", "password", "secret", "connectionstring"];

// Compound camelCase terms (lowercased). Specific enough that exact-or-suffix
// matching with [a-z] camelCase boundary is safe — these terms ARE credentials.
const COMPOUND_CAMEL = [
  "apikey",
  "secretkey",
  "privatekey",
  "accesskey",
  "authkey",
  "signingkey",
  "encryptionkey",
  // R6: token-suffix credentials common in camelCase APIs.
  "accesstoken",
  "bearertoken",
  "refreshtoken",
  "idtoken",
  "oauthtoken",
  "jwttoken",
  "apitoken",
  "authtoken",
  "sessiontoken",
  "csrftoken",
];

// Compound separator terms with [-_] support: matches both snake_case and
// kebab-case. e.g. "api[-_]key" matches "api_key" and "api-key" so headers
// like "x-api-key" are caught natively without input normalization.
// R5 note: there is intentionally NO bare `[-_]key$` catch-all alongside
// this list — only credential-prefixed variants in this list match.
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
 * Matching rules (applied after key.toLowerCase()):
 *   1. Generic words: matched only as exact key OR after separator (^ or [-_]).
 *      `mytoken` does NOT match (no separator before "token");
 *      `auth-token` DOES match.
 *   2. Compound camelCase terms: exact-or-suffix with [a-z] boundary.
 *      `accessToken` matches (lowercased "accesstoken", explicit list entry).
 *   3. Compound separator terms with [-_]: `api-key` and `api_key` both match.
 *   4. Authorization variants: whole segment only.
 *   5. Credential variants: whole segment only.
 *
 * Exported so isSensitivePath in helpers.ts can share identical semantics.
 */
export const SENSITIVE_KEY_REGEX: RegExp = new RegExp(
  [
    ...GENERIC_WORDS.map((w) => `(?:^|[-_])${w}$`),
    ...COMPOUND_CAMEL.map((t) => `(?:^|[-_a-z])${t}$`),
    ...COMPOUND_SEP.map((t) => `(?:^|[-_a-z])${t}$`),
    ...AUTH_VARIANTS.map((v) => `(?:^|[-_a-z])${v}$`),
    ...CRED_VARIANTS.map((v) => `(?:^|[-_a-z])${v}$`),
  ].join("|")
);

/**
 * Returns true if the given key name is considered sensitive (case-insensitive).
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_REGEX.test(key.toLowerCase());
}

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";

/**
 * Internal recursive walker.
 *
 * `stack` tracks objects/arrays currently on the active recursion path —
 * added on entry, removed on exit. This distinguishes true cycles (object
 * reachable from itself, still on stack when re-encountered) from shared
 * references in a DAG (same object reached via two different sibling
 * branches; not on stack the second time, so redacted normally).
 *
 * R6 finding: a permanent visited-set conflated DAGs with cycles, collapsing
 * legitimate shared references to "[Circular]".
 */
function redactUnknown(value: unknown, stack: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    if (stack.has(value)) {
      return CIRCULAR;
    }
    stack.add(value);
    try {
      return value.map((item: unknown) => redactUnknown(item, stack));
    } finally {
      stack.delete(value);
    }
  }

  if (typeof value === "object") {
    const obj = value as object;
    if (stack.has(obj)) {
      return CIRCULAR;
    }
    stack.add(obj);
    try {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = isSensitiveKey(k) ? REDACTED : redactUnknown(v, stack);
      }
      return result;
    } finally {
      stack.delete(obj);
    }
  }

  return value;
}

/**
 * Recursively walks plain objects and arrays, replacing values whose keys
 * match isSensitiveKey with "[REDACTED]".
 *
 * - Non-object/non-array values are returned as-is.
 * - null/undefined pass through without throwing.
 * - Does NOT mutate the input; returns a new structure.
 * - Detects true cycles (returns "[Circular]"); shared references in a DAG
 *   are walked normally on every branch.
 */
export function redact<T>(value: T): T {
  return redactUnknown(value, new WeakSet<object>()) as T;
}
