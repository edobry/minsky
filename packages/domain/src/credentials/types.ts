/**
 * Credential lifecycle types (mt#1426).
 *
 * A credential provider owns the four side-effectful stages of a token's
 * lifecycle that are not already covered by Minsky's config layer:
 *
 *   acquire (URL + scopes guidance) -> validate -> store -> test -> detect-401
 *
 * `use` is unchanged — existing config loaders read the stored value via
 * the path returned by `configPath`. `store` is handled by ConfigWriter.
 */

/** Outcome of a credential validation or test call. */
export interface CredentialCheckResult {
  /** True if the credential authenticates against the provider's API. */
  ok: boolean;
  /**
   * Human-readable detail. On success, a short identity line (e.g.,
   * "github:octocat", "supabase: 3 projects visible"). On failure, the
   * reason (e.g., "401 Unauthorized", "missing projects:read scope").
   */
  detail: string;
  /**
   * True when the credential authenticates but is missing scopes or
   * permissions the smoke test exercises. `ok` is still true; the caller
   * surfaces `detail` to the user as a soft warning.
   */
  scopeGap?: boolean;
  /** True when the underlying HTTP call returned 401. */
  unauthorized?: boolean;
}

/**
 * A credential provider plugin. Each registered provider corresponds to
 * exactly one `<provider>` key under `minsky config credentials add <provider>`.
 */
export interface CredentialProvider {
  /** Canonical short name (e.g., "supabase", "github", "anthropic"). */
  readonly id: string;
  /** Human-readable name shown in prompts and the cockpit. */
  readonly displayName: string;
  /** Dotted config-key path where the token persists (e.g., "supabase.accessToken"). */
  readonly configPath: string;
  /** URL the operator should open to generate the token. */
  readonly acquireUrl: string;
  /** Scope / permission guidance shown alongside the acquire URL. */
  readonly scopeGuidance: string;

  /**
   * Cheap, read-only API call confirming the credential authenticates.
   * Called BEFORE persisting. A 401 here means "do not store".
   */
  validate(token: string): Promise<CredentialCheckResult>;

  /**
   * End-to-end smoke call exercising the credential against the surface
   * Minsky actually uses it for. Called AFTER persisting. Reports scope
   * gaps as `scopeGap: true` (still ok); a 401 here means the stored
   * token has been invalidated.
   */
  test(token: string): Promise<CredentialCheckResult>;
}
