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
