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

/**
 * Character budget for `CredentialCheckResult.status`.
 *
 * MEASURED, not chosen (mt#5031). The cockpit's providers-table Detail column
 * renders at 276px at a 1440px viewport; a live CDP probe put GitHub's 46-char
 * line at exactly 276px of content — fitting, but with zero headroom — while
 * an 84-char line needed 465px and a 95-char line needed 523px. 46 is
 * therefore the empirical ceiling AT THAT VIEWPORT, so this budget is set
 * below it rather than at it: a narrower window truncates a 46-char line too.
 *
 * This is a proxy for pixels and is honest about being one — a status is
 * ultimately checked by rendering it (the widget test), not by counting.
 */
export const MAX_STATUS_LENGTH = 40;

/** Outcome of a credential validation or test call. */
export interface CredentialCheckResult {
  /** True if the credential authenticates against the provider's API. */
  ok: boolean;
  /**
   * Human-readable detail of what just happened, shown TRANSIENTLY right after
   * a validate/add — inline, untruncated, to a reader who just pressed a
   * button. A full sentence is correct here.
   *
   * On success, an identity or outcome line (e.g. "github:octocat",
   * "3 projects visible"). On failure, the reason (e.g. "401 Unauthorized"),
   * which may be long: a rejection should explain itself.
   */
  detail: string;
  /**
   * Short STATE form of a successful check, for a surface that shows a
   * credential's current standing rather than what just happened — the
   * providers table's Detail column, which is ~276px wide and scanned rather
   * than read.
   *
   * `detail` and `status` answer DIFFERENT questions, which is why this is a
   * second field rather than a shorter `detail` (mt#5031). "what just
   * happened" is an EVENT and belongs in transient feedback; "what is
   * currently true" is a STATE and belongs in a status column. One string
   * cannot be both: mt#5027 shortened the event string and it still read wrong
   * in the column, because the problem was never its length.
   *
   * Shape rules, enforced as a class invariant by
   * `providers/status-line.test.ts`:
   *   - a noun phrase describing a condition, not a report of an action and
   *     not an instruction ("stored, unverified" — not "saved — …", not
   *     "send your bot a message so …")
   *   - at most `MAX_STATUS_LENGTH` characters
   *
   * OPTIONAL, and absence is safe: a provider that supplies none gets a state
   * derived from `configured` / `lastValidatedAt` at the render site. So a
   * provider added later cannot truncate the column by forgetting this — it
   * only forgoes saying something more specific than "validated".
   *
   * Only meaningful when `ok` is true. A failure result is never persisted
   * (see `upsertMeta`'s callers), so it never reaches a status column.
   */
  status?: string;
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

  /**
   * Optional provider-owned persistence (mt#2419). When present,
   * `addCredential` calls this INSTEAD of the default ConfigWriter path —
   * for credentials whose source of truth is not `~/.config/minsky/config.yaml`
   * (e.g. the Telegram reviewer-alert bot token, which lives in the Pulumi
   * stack config because the DEPLOYED reviewer consumes it via IaC-managed
   * env vars). Returns a display-only location descriptor — never the secret.
   * Throws on persistence failure.
   */
  store?(token: string): Promise<{ location: string }>;

  /**
   * Optional companion to `store` for `listCredentials`: reports whether a
   * value is present in the provider-owned store. When absent, the listing
   * falls back to checking `configPath` in the user config file.
   */
  isConfigured?(): Promise<boolean>;

  /**
   * Optional provider-owned retrieval (mt#2419, PR #1672 R1): returns the
   * stored secret from the provider-owned store (or null when absent) so the
   * recheck flow works for credentials that don't live in config.yaml.
   * Required in practice when `store` is implemented — without it the
   * credential can never be rechecked or 401-invalidated.
   */
  read?(): Promise<string | null>;

  /**
   * Optional provider-owned removal (mt#2419, PR #1672 R1): deletes the
   * secret from the provider-owned store. Counterpart of `store` for the
   * removeCredential flow. Returns whether a value was removed.
   */
  remove?(): Promise<{ removed: boolean }>;

  /**
   * Optional environment gate (mt#2419). Providers whose storage target only
   * exists in specific environments (e.g. the Telegram reviewer-alert
   * provider, which persists into THIS deployment's Pulumi stack) return
   * false when that environment is absent — and are omitted from provider
   * listings (cockpit widget + CLI). Prevents deployment-specific providers
   * from surfacing as broken UI for users without that environment. When
   * absent, the provider is always available. See mt#2442 for the long-term
   * product-grade secrets layer that retires this class of gating.
   */
  isAvailable?(): boolean;
}
