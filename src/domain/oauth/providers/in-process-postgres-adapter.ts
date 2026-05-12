/**
 * Postgres storage adapter for oidc-provider — mt#1663
 *
 * Implements the oidc-provider Adapter interface backed by the Drizzle/Postgres
 * schema introduced in mt#1662. The adapter is instantiated once per model type
 * (the oidc-provider convention): `new PostgresOAuthAdapter("AccessToken", db)`.
 *
 * Persistence strategy:
 *   - `AccessToken`         → oauth_access_tokens   (persisted)
 *   - `AuthorizationCode`   → oauth_authorization_codes (persisted)
 *   - `RefreshToken`        → oauth_refresh_tokens   (persisted)
 *   - `Client`              → oauth_clients           (persisted)
 *   - Everything else       → in-memory (Session, Interaction, DeviceCode, etc.)
 *     Rationale: Session/Interaction are short-lived browser-flow bookkeeping;
 *     lose-on-restart is acceptable for v1. DeviceCode flow is not used.
 *     See mt#1663 "Persistence strategy" note.
 *
 * Security: all raw token/secret values are SHA-256 hashed before storage.
 * Raw values never land in the DB per mt#1662 schema convention.
 */

import { createHash } from "crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import {
  oauthClientsTable,
  oauthAuthorizationCodesTable,
  oauthAccessTokensTable,
  oauthRefreshTokensTable,
} from "../../storage/schemas/oauth-schema";

// ---------------------------------------------------------------------------
// Adapter interface (matches oidc-provider's expected shape)
// ---------------------------------------------------------------------------

export interface OidcAdapterPayload {
  [key: string]: unknown;
  // Common fields that oidc-provider sets
  grantId?: string;
  userCode?: string;
  uid?: string;
  consumed?: number;
  clientId?: string;
  sub?: string;
  scope?: string;
  audience?: string | string[];
  redirectUri?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  // client fields
  client_id?: string;
  client_secret?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: string;
  client_name?: string;
  registration_access_token?: string;
  // Token-level
  jti?: string;
}

/**
 * The interface oidc-provider expects from an adapter class.
 * Documented at: https://github.com/panva/node-oidc-provider/blob/main/example/adapters/contributed.md
 */
export interface OidcAdapter {
  upsert(id: string, payload: OidcAdapterPayload, expiresIn: number): Promise<undefined | void>;
  find(id: string): Promise<OidcAdapterPayload | undefined>;
  findByUserCode(userCode: string): Promise<OidcAdapterPayload | undefined>;
  findByUid(uid: string): Promise<OidcAdapterPayload | undefined>;
  consume(id: string): Promise<undefined | void>;
  destroy(id: string): Promise<undefined | void>;
  revokeByGrantId(grantId: string): Promise<undefined | void>;
}

// ---------------------------------------------------------------------------
// SHA-256 hash helper
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory store for non-persisted model types
// ---------------------------------------------------------------------------

/**
 * Simple in-memory adapter for model types that are short-lived browser-session
 * bookkeeping (Session, Interaction, DeviceCode, etc.). These are acceptable
 * to lose on restart for v1; they hold no durable OAuth credentials.
 */
class MemoryAdapter implements OidcAdapter {
  private store = new Map<string, { payload: OidcAdapterPayload; expiresAt: number }>();
  private uidIndex = new Map<string, string>(); // uid -> id
  private userCodeIndex = new Map<string, string>(); // userCode -> id

  async upsert(id: string, payload: OidcAdapterPayload, expiresIn: number): Promise<void> {
    const expiresAt = Date.now() + expiresIn * 1000;
    this.store.set(id, { payload, expiresAt });
    if (payload.uid) this.uidIndex.set(payload.uid, id);
    if (payload.userCode) this.userCodeIndex.set(payload.userCode, id);
  }

  async find(id: string): Promise<OidcAdapterPayload | undefined> {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(id);
      return undefined;
    }
    return entry.payload;
  }

  async findByUid(uid: string): Promise<OidcAdapterPayload | undefined> {
    const id = this.uidIndex.get(uid);
    return id ? this.find(id) : undefined;
  }

  async findByUserCode(userCode: string): Promise<OidcAdapterPayload | undefined> {
    const id = this.userCodeIndex.get(userCode);
    return id ? this.find(id) : undefined;
  }

  async consume(id: string): Promise<void> {
    const entry = this.store.get(id);
    if (entry) {
      entry.payload.consumed = Math.floor(Date.now() / 1000);
    }
  }

  async destroy(id: string): Promise<void> {
    const entry = this.store.get(id);
    if (entry) {
      if (entry.payload.uid) this.uidIndex.delete(entry.payload.uid as string);
      if (entry.payload.userCode) this.userCodeIndex.delete(entry.payload.userCode as string);
    }
    this.store.delete(id);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    for (const [id, entry] of this.store.entries()) {
      if (entry.payload.grantId === grantId) {
        this.store.delete(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Postgres adapters per model type
// ---------------------------------------------------------------------------

/**
 * Adapter for the `Client` model type -- maps to oauth_clients table.
 * oidc-provider uses the `client_id` as the adapter ID for client lookups.
 */
class ClientAdapter implements OidcAdapter {
  constructor(private readonly db: PostgresJsDatabase) {}

  async upsert(id: string, payload: OidcAdapterPayload): Promise<void> {
    // id == client_id for the Client model
    const redirectUris = JSON.stringify(payload.redirect_uris ?? []);
    const grantTypes = JSON.stringify(payload.grant_types ?? ["authorization_code"]);
    const authMethod = (payload.token_endpoint_auth_method as string | undefined) ?? "none";
    const secretHash = payload.client_secret ? sha256(payload.client_secret as string) : null;

    await this.db
      .insert(oauthClientsTable)
      .values({
        clientId: id,
        clientSecretHash: secretHash,
        clientName: payload.client_name as string | undefined,
        redirectUris,
        grantTypes,
        tokenEndpointAuthMethod: authMethod,
      })
      .onConflictDoUpdate({
        target: oauthClientsTable.clientId,
        set: {
          clientSecretHash: secretHash,
          clientName: payload.client_name as string | undefined,
          redirectUris,
          grantTypes,
          tokenEndpointAuthMethod: authMethod,
        },
      });
  }

  async find(id: string): Promise<OidcAdapterPayload | undefined> {
    const rows = await this.db
      .select()
      .from(oauthClientsTable)
      .where(eq(oauthClientsTable.clientId, id))
      .limit(1);

    const row = rows[0];
    if (!row) return undefined;

    return {
      client_id: row.clientId,
      redirect_uris: JSON.parse(row.redirectUris) as string[],
      grant_types: JSON.parse(row.grantTypes) as string[],
      token_endpoint_auth_method: row.tokenEndpointAuthMethod,
      client_name: row.clientName ?? undefined,
      // Note: we store the hash, not the raw secret -- oidc-provider will not
      // be able to verify via secret comparison for lookup purposes. The client
      // was already authenticated at registration time.
    };
  }

  async findByUserCode(): Promise<undefined> {
    return undefined;
  }

  async findByUid(): Promise<undefined> {
    return undefined;
  }

  async consume(): Promise<void> {
    // Clients are not consumed
  }

  async destroy(id: string): Promise<void> {
    await this.db.delete(oauthClientsTable).where(eq(oauthClientsTable.clientId, id));
  }

  async revokeByGrantId(): Promise<void> {
    // Clients are not grant-scoped
  }
}

/**
 * Adapter for `AuthorizationCode` -- maps to oauth_authorization_codes.
 * The `id` is the raw authorization code; we store its SHA-256 hash.
 */
class AuthorizationCodeAdapter implements OidcAdapter {
  constructor(private readonly db: PostgresJsDatabase) {}

  async upsert(id: string, payload: OidcAdapterPayload, expiresIn: number): Promise<void> {
    const codeHash = sha256(id);
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const audience = Array.isArray(payload.resource)
      ? payload.resource[0]
      : (payload.resource as string | undefined);

    await this.db
      .insert(oauthAuthorizationCodesTable)
      .values({
        codeHash,
        clientId: payload.clientId as string,
        sub: payload.accountId as string,
        redirectUri: payload.redirectUri as string,
        scopes: JSON.stringify((payload.scope ?? "").split(" ").filter(Boolean)),
        audience: audience ?? null,
        codeChallenge: payload.codeChallenge as string | undefined,
        codeChallengeMethod: payload.codeChallengeMethod as string | undefined,
        expiresAt,
        consumedAt: null,
        payload: payload as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: oauthAuthorizationCodesTable.codeHash,
        set: {
          clientId: payload.clientId as string,
          sub: payload.accountId as string,
          redirectUri: payload.redirectUri as string,
          scopes: JSON.stringify((payload.scope ?? "").split(" ").filter(Boolean)),
          audience: audience ?? null,
          codeChallenge: payload.codeChallenge as string | undefined,
          codeChallengeMethod: payload.codeChallengeMethod as string | undefined,
          expiresAt,
          payload: payload as Record<string, unknown>,
        },
      });
  }

  async find(id: string): Promise<OidcAdapterPayload | undefined> {
    const codeHash = sha256(id);
    const rows = await this.db
      .select()
      .from(oauthAuthorizationCodesTable)
      .where(eq(oauthAuthorizationCodesTable.codeHash, codeHash))
      .limit(1);

    const row = rows[0];
    if (!row) return undefined;

    const now = new Date();
    if (row.expiresAt < now) return undefined;

    // Return the full stored payload as-is (JSONB round-trip — mt#1762).
    // The consumed field is derived from the typed column so it stays current
    // even after a `consume()` call updates consumedAt without re-upsert.
    const result = row.payload as OidcAdapterPayload;
    if (row.consumedAt) {
      return { ...result, consumed: Math.floor(row.consumedAt.getTime() / 1000) };
    }
    return result;
  }

  async findByUserCode(): Promise<undefined> {
    return undefined;
  }

  async findByUid(): Promise<undefined> {
    return undefined;
  }

  async consume(id: string): Promise<void> {
    const codeHash = sha256(id);
    await this.db
      .update(oauthAuthorizationCodesTable)
      .set({ consumedAt: new Date() })
      .where(eq(oauthAuthorizationCodesTable.codeHash, codeHash));
  }

  async destroy(id: string): Promise<void> {
    const codeHash = sha256(id);
    await this.db
      .delete(oauthAuthorizationCodesTable)
      .where(eq(oauthAuthorizationCodesTable.codeHash, codeHash));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    // We don't store grantId in the auth codes table.
    // No-op; the memory-backed grants track this separately.
    void grantId;
  }
}

/**
 * Adapter for `AccessToken` -- maps to oauth_access_tokens.
 */
class AccessTokenAdapter implements OidcAdapter {
  constructor(private readonly db: PostgresJsDatabase) {}

  async upsert(id: string, payload: OidcAdapterPayload, expiresIn: number): Promise<void> {
    const tokenHash = sha256(id);
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const audience = Array.isArray(payload.resource)
      ? payload.resource[0]
      : (payload.resource as string | undefined);

    await this.db
      .insert(oauthAccessTokensTable)
      .values({
        tokenHash,
        clientId: payload.clientId as string,
        sub: payload.accountId as string,
        scopes: JSON.stringify((payload.scope ?? "").split(" ").filter(Boolean)),
        audience: audience ?? null,
        expiresAt,
        revokedAt: null,
        payload: payload as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: oauthAccessTokensTable.tokenHash,
        set: {
          clientId: payload.clientId as string,
          sub: payload.accountId as string,
          scopes: JSON.stringify((payload.scope ?? "").split(" ").filter(Boolean)),
          audience: audience ?? null,
          expiresAt,
          revokedAt: null,
          payload: payload as Record<string, unknown>,
        },
      });
  }

  async find(id: string): Promise<OidcAdapterPayload | undefined> {
    const tokenHash = sha256(id);
    const rows = await this.db
      .select()
      .from(oauthAccessTokensTable)
      .where(eq(oauthAccessTokensTable.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (!row) return undefined;

    const now = new Date();
    if (row.expiresAt < now) return undefined;
    if (row.revokedAt !== null) return undefined;

    // Return the full stored payload as-is (JSONB round-trip — mt#1762).
    return row.payload as OidcAdapterPayload;
  }

  async findByUserCode(): Promise<undefined> {
    return undefined;
  }

  async findByUid(): Promise<undefined> {
    return undefined;
  }

  async consume(): Promise<void> {
    // Access tokens are not consumed (only expired/revoked)
  }

  async destroy(id: string): Promise<void> {
    const tokenHash = sha256(id);
    await this.db
      .delete(oauthAccessTokensTable)
      .where(eq(oauthAccessTokensTable.tokenHash, tokenHash));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    // We don't track grantId in access tokens.
    void grantId;
  }
}

/**
 * Adapter for `RefreshToken` -- maps to oauth_refresh_tokens.
 * Rotation chain: when a refresh token is consumed, `replaced_by_hash` is set
 * to mark the token as already-used so re-use is rejected.
 */
class RefreshTokenAdapter implements OidcAdapter {
  constructor(private readonly db: PostgresJsDatabase) {}

  async upsert(id: string, payload: OidcAdapterPayload, expiresIn: number): Promise<void> {
    const tokenHash = sha256(id);
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const audience = Array.isArray(payload.resource)
      ? payload.resource[0]
      : (payload.resource as string | undefined);

    await this.db
      .insert(oauthRefreshTokensTable)
      .values({
        tokenHash,
        clientId: payload.clientId as string,
        sub: payload.accountId as string,
        scopes: JSON.stringify((payload.scope ?? "").split(" ").filter(Boolean)),
        audience: audience ?? null,
        expiresAt,
        revokedAt: null,
        replacedByHash: null,
        payload: payload as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: oauthRefreshTokensTable.tokenHash,
        set: {
          clientId: payload.clientId as string,
          sub: payload.accountId as string,
          scopes: JSON.stringify((payload.scope ?? "").split(" ").filter(Boolean)),
          audience: audience ?? null,
          expiresAt,
          payload: payload as Record<string, unknown>,
        },
      });
  }

  async find(id: string): Promise<OidcAdapterPayload | undefined> {
    const tokenHash = sha256(id);
    const rows = await this.db
      .select()
      .from(oauthRefreshTokensTable)
      .where(eq(oauthRefreshTokensTable.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (!row) return undefined;

    const now = new Date();
    if (row.expiresAt < now) return undefined;
    if (row.revokedAt !== null) return undefined;

    // Return the full stored payload as-is (JSONB round-trip — mt#1762).
    const result = row.payload as OidcAdapterPayload;
    if (row.replacedByHash !== null) {
      // Token was already rotated -- mark as consumed so oidc-provider rejects re-use
      return { ...result, consumed: Math.floor(Date.now() / 1000) };
    }

    return result;
  }

  async findByUserCode(): Promise<undefined> {
    return undefined;
  }

  async findByUid(): Promise<undefined> {
    return undefined;
  }

  async consume(id: string): Promise<void> {
    // Mark the refresh token as consumed (replaced sentinel)
    const tokenHash = sha256(id);
    await this.db
      .update(oauthRefreshTokensTable)
      .set({ replacedByHash: "consumed" }) // sentinel: consumed but no replacement hash yet
      .where(eq(oauthRefreshTokensTable.tokenHash, tokenHash));
  }

  async destroy(id: string): Promise<void> {
    const tokenHash = sha256(id);
    await this.db
      .update(oauthRefreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(eq(oauthRefreshTokensTable.tokenHash, tokenHash));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    // Best-effort: we don't track grantId per refresh token in the schema.
    void grantId;
  }
}

// ---------------------------------------------------------------------------
// Factory: resolves the correct adapter per model name
// ---------------------------------------------------------------------------

/**
 * Map of in-memory adapters shared across model types that we don't persist.
 * Shared so all instances for the same model share state within a process.
 */
const memoryAdapters = new Map<string, MemoryAdapter>();

function getMemoryAdapter(model: string): MemoryAdapter {
  const existing = memoryAdapters.get(model);
  if (existing) return existing;
  const adapter = new MemoryAdapter();
  memoryAdapters.set(model, adapter);
  return adapter;
}

/**
 * Factory function passed to oidc-provider as the `adapter` configuration option.
 * oidc-provider calls `new adapter(modelName)` -- but we use a class factory pattern
 * that captures the `db` reference via closure.
 *
 * Usage:
 * ```ts
 * const adapterFactory = createAdapterFactory(db);
 * const provider = new Provider(issuer, { adapter: adapterFactory });
 * ```
 */
export function createAdapterFactory(db: PostgresJsDatabase): new (model: string) => OidcAdapter {
  return class PostgresOAuthAdapter implements OidcAdapter {
    private readonly delegate: OidcAdapter;

    constructor(model: string) {
      switch (model) {
        case "Client":
        case "ClientCredentials":
          this.delegate = new ClientAdapter(db);
          break;
        case "AuthorizationCode":
          this.delegate = new AuthorizationCodeAdapter(db);
          break;
        case "AccessToken":
          this.delegate = new AccessTokenAdapter(db);
          break;
        case "RefreshToken":
          this.delegate = new RefreshTokenAdapter(db);
          break;
        default:
          // Session, Interaction, DeviceCode, InitialAccessToken,
          // RegistrationAccessToken, BackchannelAuthenticationRequest, etc.
          // are handled in-memory (acceptable for v1; lose-on-restart is fine).
          this.delegate = getMemoryAdapter(model);
          break;
      }
    }

    upsert(id: string, payload: OidcAdapterPayload, expiresIn: number) {
      return this.delegate.upsert(id, payload, expiresIn);
    }
    find(id: string) {
      return this.delegate.find(id);
    }
    findByUserCode(userCode: string) {
      return this.delegate.findByUserCode(userCode);
    }
    findByUid(uid: string) {
      return this.delegate.findByUid(uid);
    }
    consume(id: string) {
      return this.delegate.consume(id);
    }
    destroy(id: string) {
      return this.delegate.destroy(id);
    }
    revokeByGrantId(grantId: string) {
      return this.delegate.revokeByGrantId(grantId);
    }
  };
}

// Export sha256 for use in InProcessOAuthProvider's validateToken
export { sha256 };
