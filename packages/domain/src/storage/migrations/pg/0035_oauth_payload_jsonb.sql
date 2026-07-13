-- Add JSONB payload column to OAuth token tables — mt#1762
--
-- Each of the three persistent oidc-provider models (AuthorizationCode,
-- AccessToken, RefreshToken) now stores the FULL oidc-provider payload as
-- JSONB. The adapter writes the complete payload on upsert and returns it
-- as-is on find, eliminating field-name mismatch bugs (mt#1760 accountId/sub,
-- mt#1761 resource/audience, and the grantId issue).
--
-- The existing typed columns remain for query convenience (denormalized),
-- but JSONB becomes the source of truth for the adapter round-trip contract.
--
-- Default '{}'::jsonb keeps existing rows valid under NOT NULL.
--
-- PR #1061 R1: backfill payload from existing typed columns so historical
-- rows are not deserialized as empty payloads (oidc-provider would lose
-- clientId/accountId/scope/etc. for any row created before this migration).
--
-- Backout:
--   ALTER TABLE oauth_authorization_codes DROP COLUMN IF EXISTS payload;
--   ALTER TABLE oauth_access_tokens DROP COLUMN IF EXISTS payload;
--   ALTER TABLE oauth_refresh_tokens DROP COLUMN IF EXISTS payload;

ALTER TABLE "oauth_authorization_codes"
  ADD COLUMN IF NOT EXISTS "payload" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

ALTER TABLE "oauth_access_tokens"
  ADD COLUMN IF NOT EXISTS "payload" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

ALTER TABLE "oauth_refresh_tokens"
  ADD COLUMN IF NOT EXISTS "payload" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

-- Backfill: populate payload for existing rows from typed columns.
-- Only updates rows where payload is still the default empty object,
-- so re-running the migration on partially-applied state is safe.
-- The "scopes" column is stored as a JSON-string text column (e.g. '["mcp"]'),
-- which oidc-provider's IN_PAYLOAD expects as a space-separated `scope` string.
-- The accountId/sub and resource/audience mappings mirror the adapter's
-- denormalization (mt#1760 / mt#1761).

UPDATE "oauth_authorization_codes" SET "payload" = jsonb_build_object(
  'clientId', "client_id",
  'accountId', "sub",
  'redirectUri', "redirect_uri",
  'scope', array_to_string(ARRAY(SELECT jsonb_array_elements_text("scopes"::jsonb)), ' '),
  'resource', "audience",
  'codeChallenge', "code_challenge",
  'codeChallengeMethod', "code_challenge_method"
) WHERE "payload" = '{}'::jsonb;
--> statement-breakpoint

UPDATE "oauth_access_tokens" SET "payload" = jsonb_build_object(
  'clientId', "client_id",
  'accountId', "sub",
  'scope', array_to_string(ARRAY(SELECT jsonb_array_elements_text("scopes"::jsonb)), ' '),
  'resource', "audience"
) WHERE "payload" = '{}'::jsonb;
--> statement-breakpoint

UPDATE "oauth_refresh_tokens" SET "payload" = jsonb_build_object(
  'clientId', "client_id",
  'accountId', "sub",
  'scope', array_to_string(ARRAY(SELECT jsonb_array_elements_text("scopes"::jsonb)), ' '),
  'resource', "audience"
) WHERE "payload" = '{}'::jsonb;
