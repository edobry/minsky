/**
 * OAuth schema shape-sanity tests — mt#1662
 *
 * Verifies that the Drizzle table definitions have the expected column names,
 * FK relationships, and that the SQL migration file contains the required DDL.
 *
 * These are pure unit tests — no live DB required.
 */

/* eslint-disable custom/no-real-fs-in-tests -- reading shipped migration SQL IS the point of drift checks */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  oauthClientsTable,
  oauthAuthorizationCodesTable,
  oauthAccessTokensTable,
  oauthRefreshTokensTable,
} from "./oauth-schema";

const MIGRATIONS_DIR = join(import.meta.dir, "../migrations/pg");

// ---------------------------------------------------------------------------
// oauth_clients shape
// ---------------------------------------------------------------------------

describe("oauthClientsTable shape", () => {
  test("clientId column has correct DB name", () => {
    expect(oauthClientsTable.clientId.name).toBe("client_id");
  });

  test("clientSecretHash column has correct DB name", () => {
    expect(oauthClientsTable.clientSecretHash.name).toBe("client_secret_hash");
  });

  test("clientName column has correct DB name", () => {
    expect(oauthClientsTable.clientName.name).toBe("client_name");
  });

  test("redirectUris column has correct DB name", () => {
    expect(oauthClientsTable.redirectUris.name).toBe("redirect_uris");
  });

  test("grantTypes column has correct DB name", () => {
    expect(oauthClientsTable.grantTypes.name).toBe("grant_types");
  });

  test("tokenEndpointAuthMethod column has correct DB name", () => {
    expect(oauthClientsTable.tokenEndpointAuthMethod.name).toBe("token_endpoint_auth_method");
  });

  test("registrationAccessTokenHash column has correct DB name", () => {
    expect(oauthClientsTable.registrationAccessTokenHash.name).toBe(
      "registration_access_token_hash"
    );
  });

  test("createdAt column has correct DB name", () => {
    expect(oauthClientsTable.createdAt.name).toBe("created_at");
  });
});

// ---------------------------------------------------------------------------
// oauth_authorization_codes shape
// ---------------------------------------------------------------------------

describe("oauthAuthorizationCodesTable shape", () => {
  test("codeHash column has correct DB name (PK)", () => {
    expect(oauthAuthorizationCodesTable.codeHash.name).toBe("code_hash");
  });

  test("clientId column has correct DB name (FK)", () => {
    expect(oauthAuthorizationCodesTable.clientId.name).toBe("client_id");
  });

  test("sub column has correct DB name", () => {
    expect(oauthAuthorizationCodesTable.sub.name).toBe("sub");
  });

  test("redirectUri column has correct DB name", () => {
    expect(oauthAuthorizationCodesTable.redirectUri.name).toBe("redirect_uri");
  });

  test("scopes column has correct DB name", () => {
    expect(oauthAuthorizationCodesTable.scopes.name).toBe("scopes");
  });

  test("audience column has correct DB name (nullable RFC 8707)", () => {
    expect(oauthAuthorizationCodesTable.audience.name).toBe("audience");
  });

  test("codeChallenge column has correct DB name (nullable PKCE)", () => {
    expect(oauthAuthorizationCodesTable.codeChallenge.name).toBe("code_challenge");
  });

  test("codeChallengeMethod column has correct DB name (nullable PKCE)", () => {
    expect(oauthAuthorizationCodesTable.codeChallengeMethod.name).toBe("code_challenge_method");
  });

  test("expiresAt column has correct DB name", () => {
    expect(oauthAuthorizationCodesTable.expiresAt.name).toBe("expires_at");
  });

  test("consumedAt column has correct DB name (nullable — single-use flag)", () => {
    expect(oauthAuthorizationCodesTable.consumedAt.name).toBe("consumed_at");
  });
});

// ---------------------------------------------------------------------------
// oauth_access_tokens shape
// ---------------------------------------------------------------------------

describe("oauthAccessTokensTable shape", () => {
  test("access tokenHash column has correct DB name (PK)", () => {
    expect(oauthAccessTokensTable.tokenHash.name).toBe("token_hash");
  });

  test("access clientId column has correct DB name (FK → oauth_clients)", () => {
    expect(oauthAccessTokensTable.clientId.name).toBe("client_id");
  });

  test("access sub column has correct DB name", () => {
    expect(oauthAccessTokensTable.sub.name).toBe("sub");
  });

  test("access scopes column has correct DB name", () => {
    expect(oauthAccessTokensTable.scopes.name).toBe("scopes");
  });

  test("access audience column has correct DB name (nullable RFC 8707)", () => {
    expect(oauthAccessTokensTable.audience.name).toBe("audience");
  });

  test("access expiresAt column has correct DB name", () => {
    expect(oauthAccessTokensTable.expiresAt.name).toBe("expires_at");
  });

  test("access revokedAt column has correct DB name (nullable)", () => {
    expect(oauthAccessTokensTable.revokedAt.name).toBe("revoked_at");
  });
});

// ---------------------------------------------------------------------------
// oauth_refresh_tokens shape
// ---------------------------------------------------------------------------

describe("oauthRefreshTokensTable shape", () => {
  test("refresh tokenHash column has correct DB name (PK)", () => {
    expect(oauthRefreshTokensTable.tokenHash.name).toBe("token_hash");
  });

  test("refresh clientId column has correct DB name (FK → oauth_clients)", () => {
    expect(oauthRefreshTokensTable.clientId.name).toBe("client_id");
  });

  test("refresh sub column has correct DB name", () => {
    expect(oauthRefreshTokensTable.sub.name).toBe("sub");
  });

  test("refresh scopes column has correct DB name", () => {
    expect(oauthRefreshTokensTable.scopes.name).toBe("scopes");
  });

  test("refresh audience column has correct DB name (nullable RFC 8707)", () => {
    expect(oauthRefreshTokensTable.audience.name).toBe("audience");
  });

  test("refresh expiresAt column has correct DB name", () => {
    expect(oauthRefreshTokensTable.expiresAt.name).toBe("expires_at");
  });

  test("refresh revokedAt column has correct DB name (nullable)", () => {
    expect(oauthRefreshTokensTable.revokedAt.name).toBe("revoked_at");
  });

  test("replacedByHash column has correct DB name (nullable rotation chain)", () => {
    expect(oauthRefreshTokensTable.replacedByHash.name).toBe("replaced_by_hash");
  });
});

// ---------------------------------------------------------------------------
// SQL migration sanity check
// ---------------------------------------------------------------------------

describe("0031_oauth_schema.sql migration sanity", () => {
  const migrationPath = join(MIGRATIONS_DIR, "0031_oauth_schema.sql");

  test("migration file exists and is readable", () => {
    expect(() => readFileSync(migrationPath)).not.toThrow();
  });

  test("migration creates oauth_clients table", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "oauth_clients"');
  });

  test("migration creates oauth_authorization_codes table", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "oauth_authorization_codes"');
  });

  test("migration creates oauth_access_tokens table", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "oauth_access_tokens"');
  });

  test("migration creates oauth_refresh_tokens table", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens"');
  });

  test("migration includes client_secret_hash column (never raw secrets)", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("client_secret_hash");
  });

  test("migration includes code_challenge column (PKCE — RFC 7636)", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("code_challenge");
  });

  test("migration includes audience column (RFC 8707 resource indicators)", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("audience");
  });

  test("migration includes revoked_at column (access tokens)", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("revoked_at");
  });

  test("migration includes replaced_by_hash column (refresh token rotation chain)", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("replaced_by_hash");
  });

  test("migration includes FK from authorization_codes → clients", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("fk_auth_codes_client_id");
  });

  test("migration includes FK from access_tokens → clients", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("fk_access_tokens_client_id");
  });

  test("migration includes FK from refresh_tokens → clients", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("fk_refresh_tokens_client_id");
  });

  test("migration includes backout instructions as a comment", () => {
    const sql = readFileSync(migrationPath).toString();
    expect(sql).toContain("Backout");
  });
});
