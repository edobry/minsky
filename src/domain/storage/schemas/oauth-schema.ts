import { pgTable, text, timestamp, index, foreignKey, jsonb } from "drizzle-orm/pg-core";

/**
 * OAuth token-store schema — mt#1662
 *
 * Four tables back the `InProcessOAuthProvider` (mt#1663) Postgres adapter:
 *
 *   oauth_clients              — DCR-registered clients (RFC 7591)
 *   oauth_authorization_codes  — PKCE authorization codes (RFC 7636)
 *   oauth_access_tokens        — issued access tokens
 *   oauth_refresh_tokens       — refresh tokens with rotation chain (RFC 6749 §6)
 *
 * Design conventions (consistent with asks/pr-watches schemas):
 * - text PK — OAuth IDs are opaque strings, not UUIDs; client_id is a
 *   client-assigned or server-generated string.
 * - All secret/token values stored as SHA-256 hash (suffix `_hash`) —
 *   raw secrets never written to the DB (mt#1662 constraint).
 * - text[] stored as JSON-encoded text for portability with drizzle-orm's
 *   pg `text` columns; production Postgres uses native text[].
 * - withTimezone on all timestamps.
 * - snake_case column names, camelCase TypeScript identifiers.
 * - FK constraints enforced where referential integrity matters.
 */

// ---------------------------------------------------------------------------
// oauth_clients
// ---------------------------------------------------------------------------

/**
 * Registered OAuth clients — one row per Dynamic Client Registration.
 * client_secret_hash and registration_access_token_hash store SHA-256
 * digests of the raw secrets so the DB never holds plaintext credentials.
 */
export const oauthClientsTable = pgTable(
  "oauth_clients",
  {
    /** Server-generated or client-supplied opaque client identifier. */
    clientId: text("client_id").primaryKey(),

    /** SHA-256 hash of the client_secret. NULL for public clients. */
    clientSecretHash: text("client_secret_hash"),

    /** Human-readable client name from the DCR request. */
    clientName: text("client_name"),

    /**
     * Allowed redirect URIs. Stored as a JSON-encoded string array.
     * Example: '["https://example.com/callback"]'
     */
    redirectUris: text("redirect_uris").notNull(),

    /**
     * Allowed grant types. Stored as a JSON-encoded string array.
     * Example: '["authorization_code","refresh_token"]'
     */
    grantTypes: text("grant_types").notNull(),

    /**
     * Token endpoint authentication method.
     * Typical values: "client_secret_basic", "client_secret_post", "none".
     */
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),

    /**
     * SHA-256 hash of the registration_access_token.
     * NULL when the server does not issue registration management tokens.
     */
    registrationAccessTokenHash: text("registration_access_token_hash"),

    /** When this client was registered. */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Index for looking up clients by name (admin/audit queries)
    byClientName: index("idx_oauth_clients_name").on(table.clientName),
  })
);

// ---------------------------------------------------------------------------
// oauth_authorization_codes
// ---------------------------------------------------------------------------

/**
 * PKCE authorization codes — one row per authorization code grant.
 * The `code_hash` column stores the SHA-256 of the authorization code,
 * so the raw code value is never persisted.
 * `consumed_at` is set when the code is exchanged for a token (single-use).
 */
export const oauthAuthorizationCodesTable = pgTable(
  "oauth_authorization_codes",
  {
    /** SHA-256 hash of the authorization code. */
    codeHash: text("code_hash").primaryKey(),

    /** FK → oauth_clients.client_id */
    clientId: text("client_id").notNull(),

    /** OAuth `sub` claim — resource owner identifier. */
    sub: text("sub").notNull(),

    /** Redirect URI the code was issued for (must match at exchange time). */
    redirectUri: text("redirect_uri").notNull(),

    /**
     * Granted scopes. Stored as a JSON-encoded string array.
     * Example: '["openid","profile"]'
     */
    scopes: text("scopes").notNull(),

    /**
     * RFC 8707 audience — the resource server this code targets.
     * NULL when the client did not request a specific audience.
     */
    audience: text("audience"),

    /** RFC 7636 PKCE code_challenge. NULL only for legacy non-PKCE flows (not recommended). */
    codeChallenge: text("code_challenge"),

    /** RFC 7636 PKCE method. Typically "S256". NULL when codeChallenge is NULL. */
    codeChallengeMethod: text("code_challenge_method"),

    /** When this code expires (typically 60–300 seconds after issuance). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /**
     * When this code was successfully exchanged for a token.
     * NULL = not yet consumed. Non-null = already used (reject re-use).
     */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),

    /**
     * Full oidc-provider payload as JSONB — mt#1762.
     * Source of truth for the adapter round-trip contract. Written on upsert
     * from the complete payload object; returned as-is on find.
     * The typed columns above remain for query convenience (denormalized).
     */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    // FK: authorization code → client
    clientFk: foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClientsTable.clientId],
      name: "fk_auth_codes_client_id",
    }),

    // Index for cleanup sweeper (find expired codes)
    byExpiresAt: index("idx_oauth_auth_codes_expires_at").on(table.expiresAt),

    // Index for lookups by client + sub (revocation, audit)
    byClientSub: index("idx_oauth_auth_codes_client_sub").on(table.clientId, table.sub),
  })
);

// ---------------------------------------------------------------------------
// oauth_access_tokens
// ---------------------------------------------------------------------------

/**
 * Issued access tokens — one row per active access token.
 * `token_hash` stores SHA-256 of the raw bearer string so plaintext tokens
 * are never written to disk.
 * `revoked_at` is set for explicit revocations; validation also checks `expires_at`.
 */
export const oauthAccessTokensTable = pgTable(
  "oauth_access_tokens",
  {
    /** SHA-256 hash of the bearer token string. */
    tokenHash: text("token_hash").primaryKey(),

    /** FK → oauth_clients.client_id */
    clientId: text("client_id").notNull(),

    /** OAuth `sub` claim — resource owner identifier. */
    sub: text("sub").notNull(),

    /**
     * Granted scopes. Stored as a JSON-encoded string array.
     * Example: '["openid","profile"]'
     */
    scopes: text("scopes").notNull(),

    /**
     * RFC 8707 audience — the resource server this token targets.
     * NULL when the client did not request a specific audience.
     */
    audience: text("audience"),

    /** When this token expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /**
     * When this token was explicitly revoked.
     * NULL = still valid (subject to expiresAt check).
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /**
     * Full oidc-provider payload as JSONB — mt#1762.
     * Source of truth for the adapter round-trip contract. Written on upsert
     * from the complete payload object; returned as-is on find.
     * The typed columns above remain for query convenience (denormalized).
     */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    // FK: access token → client
    clientFk: foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClientsTable.clientId],
      name: "fk_access_tokens_client_id",
    }),

    // Index for validation middleware: look up by token_hash (primary path)
    // Covered by the PK; no additional index needed.

    // Index for cleanup sweeper: find expired / revoked tokens
    byExpiresAt: index("idx_oauth_access_tokens_expires_at").on(table.expiresAt),

    // Index for revocation lookups by client + sub
    byClientSub: index("idx_oauth_access_tokens_client_sub").on(table.clientId, table.sub),
  })
);

// ---------------------------------------------------------------------------
// oauth_refresh_tokens
// ---------------------------------------------------------------------------

/**
 * Refresh tokens with rotation chain — one row per issued refresh token.
 * Each rotation replaces the previous token and sets `replaced_by_hash` to the
 * new token's hash, forming an audit chain. `revoked_at` is set when a token is
 * explicitly revoked (e.g., logout or key compromise).
 */
export const oauthRefreshTokensTable = pgTable(
  "oauth_refresh_tokens",
  {
    /** SHA-256 hash of the refresh token string. */
    tokenHash: text("token_hash").primaryKey(),

    /** FK → oauth_clients.client_id */
    clientId: text("client_id").notNull(),

    /** OAuth `sub` claim — resource owner identifier. */
    sub: text("sub").notNull(),

    /**
     * Granted scopes. Stored as a JSON-encoded string array.
     * Example: '["openid","offline_access"]'
     */
    scopes: text("scopes").notNull(),

    /**
     * RFC 8707 audience — the resource server this token targets.
     * NULL when the client did not request a specific audience.
     */
    audience: text("audience"),

    /** When this refresh token expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /**
     * When this token was explicitly revoked.
     * NULL = still valid (subject to expiresAt check).
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /**
     * SHA-256 hash of the replacement refresh token issued during rotation.
     * NULL = this token has not been rotated yet.
     * Non-null = this token was already used to issue a new one (reject re-use).
     * Self-referential: replaced_by_hash → oauth_refresh_tokens.token_hash.
     */
    replacedByHash: text("replaced_by_hash"),

    /**
     * Full oidc-provider payload as JSONB — mt#1762.
     * Source of truth for the adapter round-trip contract. Written on upsert
     * from the complete payload object; returned as-is on find.
     * The typed columns above remain for query convenience (denormalized).
     */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    // FK: refresh token → client
    clientFk: foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClientsTable.clientId],
      name: "fk_refresh_tokens_client_id",
    }),

    // Self-FK for rotation chain: replaced_by_hash → token_hash
    // NOTE: Omitted as a DB-level constraint to avoid circular FK complexity
    // during batch inserts. Integrity is enforced at the application layer.
    // See mt#1663 for the rotation logic.

    // Index for cleanup sweeper: find expired / revoked tokens
    byExpiresAt: index("idx_oauth_refresh_tokens_expires_at").on(table.expiresAt),

    // Index for revocation lookups by client + sub
    byClientSub: index("idx_oauth_refresh_tokens_client_sub").on(table.clientId, table.sub),
  })
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type OAuthClientRecord = typeof oauthClientsTable.$inferSelect;
export type OAuthClientInsert = typeof oauthClientsTable.$inferInsert;

export type OAuthAuthorizationCodeRecord = typeof oauthAuthorizationCodesTable.$inferSelect;
export type OAuthAuthorizationCodeInsert = typeof oauthAuthorizationCodesTable.$inferInsert;

export type OAuthAccessTokenRecord = typeof oauthAccessTokensTable.$inferSelect;
export type OAuthAccessTokenInsert = typeof oauthAccessTokensTable.$inferInsert;

export type OAuthRefreshTokenRecord = typeof oauthRefreshTokensTable.$inferSelect;
export type OAuthRefreshTokenInsert = typeof oauthRefreshTokensTable.$inferInsert;
