/**
 * Connection-string masking (mt#2429).
 *
 * Single source of truth for redacting credentials out of Postgres connection
 * strings before they are logged, returned in errors, or shown to the user.
 * Centralized so the masking regex cannot drift between call sites (the
 * previous per-site `:\/\/[^:]+:[^@]+@` copies failed to mask an empty
 * username, e.g. `postgresql://:pass@host` — PR #1666 review).
 */

/**
 * Replace the `user:password` segment of any `scheme://user:pass@host` URI with
 * `***:***`. Handles an empty username (`://:pass@…`) and an empty password
 * (`://user:@…`). Strings with no `user:pass@` userinfo are returned unchanged.
 *
 * Applied to arbitrary text too (e.g. a driver error message that may embed the
 * connection string): every `://user:pass@` occurrence in the input is masked.
 */
export function maskConnectionString(input: string): string {
  // (://) then username (no ':' '/' '@', may be empty), ':', password (no '@',
  // may be empty), '@'. The trailing '@' anchor prevents matching a bare
  // `host:port/db` that has no userinfo.
  return input.replace(/(:\/\/)[^:/@]*:[^@]*@/g, "$1***:***@");
}
