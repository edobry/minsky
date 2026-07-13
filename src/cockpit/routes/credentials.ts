/**
 * Cockpit credential routes (mt#2615 — extracted from server.ts, mt#1426).
 *
 * Cockpit surface for the credential lifecycle.
 *
 * Trust-boundary policy:
 *   - The token value is consumed in-process only. It MUST NOT appear in any
 *     response body, error message, or log line (across all four endpoints).
 *   - Body reads are guarded with try/catch; `req.body.token` may not be a string.
 *   - 400 on unknown provider or missing/invalid token; 200 on success.
 */
import type express from "express";
import { log } from "@minsky/shared/logger";

/**
 * Minimal interface for the credential module surface used by the server's
 * credential endpoints. Defined here (not imported from the real domain
 * module) so tests can inject doubles without needing to write to the
 * filesystem.
 */
export interface CredentialModuleOverride {
  getCredentialProvider: (id: string) =>
    | {
        validate: (
          token: string
        ) => Promise<import("@minsky/domain/credentials").CredentialCheckResult>;
      }
    | undefined;
  addCredential: (
    provider: string,
    token: string
  ) => Promise<import("@minsky/domain/credentials").AddCredentialResult>;
  listCredentials: () => Promise<import("@minsky/domain/credentials").CredentialListing[]>;
  removeCredential: (provider: string) => Promise<{ removed: boolean }>;
  listCredentialProviders: () => readonly {
    id: string;
    displayName: string;
    acquireUrl: string;
    scopeGuidance: string;
  }[];
}

// Normalized error response helper (mt#1426 PR #1142 R1).
//
// Returns errors as `{ error: { code, message } }` with stable user-safe
// `code` values and user-safe `message` strings. Raw exception text is
// logged server-side via `log.error` but NEVER returned to the client —
// closes the "raw err.message coupled to UI" reviewer finding.
//
// Stable codes:
//   - `invalid_body`        — request body shape unparseable
//   - `missing_field`       — required field absent or wrong type
//   - `unknown_provider`    — provider id not in registry
//   - `validation_failed`   — provider.validate(token) returned !ok
//                             (response also carries the structured
//                             `validate: { ok, detail, unauthorized?, scopeGap? }`
//                             so the UI can render specific failure states)
//   - `internal`            — unexpected exception (raw message NOT returned)
type CredentialErrorCode =
  | "invalid_body"
  | "missing_field"
  | "unknown_provider"
  | "validation_failed"
  | "internal";

function credentialError(
  res: express.Response,
  status: number,
  code: CredentialErrorCode,
  message: string,
  extras?: Record<string, unknown>
): void {
  res.status(status).json({ error: { code, message }, ...(extras ?? {}) });
}

function logCredentialInternal(route: string, err: unknown): void {
  // Internal errors are logged server-side for operator debugging, but the
  // user-facing response carries only `{ code: "internal", message: "..." }` —
  // never the raw exception text. Keeps internal details out of the UI per
  // PR #1142 R1.
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log.error(`[credentials] ${route} — internal error: ${detail}`);
}

/** Options accepted by {@link mountCredentialRoutes}. */
export interface CredentialRoutesOptions {
  /** Override the credential module used by all five endpoints (used in tests). */
  credModuleOverride: CredentialModuleOverride | null;
}

/** Mount the /api/credentials* routes on `app`. */
export function mountCredentialRoutes(app: express.Express, opts: CredentialRoutesOptions): void {
  const { credModuleOverride } = opts;

  /**
   * GET /api/credentials/providers
   *
   * Returns: { providers: { id, displayName, acquireUrl, scopeGuidance }[] }
   * One entry per registered credential provider.
   */
  app.get("/api/credentials/providers", async (_req, res) => {
    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const providers = [...credMod.listCredentialProviders()].map((p) => ({
        id: p.id,
        displayName: p.displayName,
        acquireUrl: p.acquireUrl,
        scopeGuidance: p.scopeGuidance,
      }));
      res.json({ providers });
    } catch (err) {
      logCredentialInternal("GET /api/credentials/providers", err);
      credentialError(
        res,
        500,
        "internal",
        "An internal error occurred while listing credential providers."
      );
    }
  });

  /**
   * POST /api/credentials/validate
   *
   * Body: { provider: string; token: string }
   * Returns: { ok: boolean; detail: string; unauthorized?: boolean; scopeGap?: boolean }
   *
   * Calls provider.validate(token) — read-only, never persists.
   * The token is consumed in memory and never echoed back.
   * Errors: `{ error: { code, message } }` with codes above.
   */
  app.post("/api/credentials/validate", async (req, res) => {
    let provider: string | undefined;
    let token: string | undefined;
    try {
      const body = req.body as { provider?: unknown; token?: unknown };
      provider = typeof body.provider === "string" ? body.provider : undefined;
      token = typeof body.token === "string" ? body.token : undefined;
    } catch {
      credentialError(res, 400, "invalid_body", "Request body could not be parsed.");
      return;
    }

    if (!provider) {
      credentialError(res, 400, "missing_field", "`provider` is required.");
      return;
    }
    if (!token) {
      credentialError(res, 400, "missing_field", "`token` is required.");
      return;
    }

    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const credentialProvider = credMod.getCredentialProvider(provider);
      if (!credentialProvider) {
        credentialError(res, 400, "unknown_provider", `Unknown credential provider: ${provider}.`);
        return;
      }
      const result = await credentialProvider.validate(token);
      res.json({
        ok: result.ok,
        detail: result.detail,
        ...(result.unauthorized !== undefined ? { unauthorized: result.unauthorized } : {}),
        ...(result.scopeGap !== undefined ? { scopeGap: result.scopeGap } : {}),
      });
    } catch (err) {
      logCredentialInternal("POST /api/credentials/validate", err);
      credentialError(res, 500, "internal", "An internal error occurred during validation.");
    }
  });

  /**
   * POST /api/credentials/add
   *
   * Body: { provider: string; token: string }
   * Returns: { provider, validate, stored?, test? } — never includes the token.
   *
   * Calls addCredential(provider, token). Returns 400 with code "validation_failed"
   * and the structured `validate` result when the provider rejects the token.
   */
  app.post("/api/credentials/add", async (req, res) => {
    let provider: string | undefined;
    let token: string | undefined;
    try {
      const body = req.body as { provider?: unknown; token?: unknown };
      provider = typeof body.provider === "string" ? body.provider : undefined;
      token = typeof body.token === "string" ? body.token : undefined;
    } catch {
      credentialError(res, 400, "invalid_body", "Request body could not be parsed.");
      return;
    }

    if (!provider) {
      credentialError(res, 400, "missing_field", "`provider` is required.");
      return;
    }
    if (!token) {
      credentialError(res, 400, "missing_field", "`token` is required.");
      return;
    }

    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const credentialProvider = credMod.getCredentialProvider(provider);
      if (!credentialProvider) {
        credentialError(res, 400, "unknown_provider", `Unknown credential provider: ${provider}.`);
        return;
      }
      const result = await credMod.addCredential(provider, token);
      if (!result.validate.ok) {
        // Preserve the structured validate result so the UI can render
        // specific states (unauthorized / scopeGap) without parsing text.
        credentialError(
          res,
          400,
          "validation_failed",
          "Credential validation failed. See `validate` for details.",
          { validate: result.validate }
        );
        return;
      }
      res.json(result);
    } catch (err) {
      logCredentialInternal("POST /api/credentials/add", err);
      credentialError(
        res,
        500,
        "internal",
        "An internal error occurred while adding the credential."
      );
    }
  });

  /**
   * GET /api/credentials
   *
   * Returns: { credentials: CredentialListing[] }
   * One entry per known provider — never includes token values.
   */
  app.get("/api/credentials", async (_req, res) => {
    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const credentials = await credMod.listCredentials();
      res.json({ credentials });
    } catch (err) {
      logCredentialInternal("GET /api/credentials", err);
      credentialError(
        res,
        500,
        "internal",
        "An internal error occurred while listing credentials."
      );
    }
  });

  /**
   * DELETE /api/credentials/:provider
   *
   * Returns: { removed: boolean }
   * 400 with code "unknown_provider" on unknown provider; 200 on success.
   */
  app.delete("/api/credentials/:provider", async (req, res) => {
    const providerId = req.params.provider;
    if (!providerId) {
      credentialError(res, 400, "missing_field", "`provider` is required.");
      return;
    }

    try {
      const credMod = credModuleOverride ?? (await import("@minsky/domain/credentials"));
      const credentialProvider = credMod.getCredentialProvider(providerId);
      if (!credentialProvider) {
        credentialError(
          res,
          400,
          "unknown_provider",
          `Unknown credential provider: ${providerId}.`
        );
        return;
      }
      const result = await credMod.removeCredential(providerId);
      res.json(result);
    } catch (err) {
      logCredentialInternal("DELETE /api/credentials/:provider", err);
      credentialError(
        res,
        500,
        "internal",
        "An internal error occurred while removing the credential."
      );
    }
  });
}
