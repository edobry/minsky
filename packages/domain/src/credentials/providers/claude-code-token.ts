/**
 * Claude Code subscription-token provider (mt#5022).
 *
 * `claude setup-token` mints a long-lived token billed against a Claude
 * SUBSCRIPTION. Its sibling `anthropic` provider holds an `apiKey`, which is
 * billed against API CREDITS. They are two credentials with different billing,
 * different acquisition and different validation, which is why this is a
 * separate provider rather than a second field on that one — a single provider
 * cannot give correct acquisition guidance for both.
 *
 * ## Why there is no live validation yet
 *
 * The `anthropic` provider validates by calling `GET /v1/models` with an
 * `x-api-key` header. A subscription token is not an API key and may not
 * authenticate there under any header; nothing in Anthropic's published
 * settings documentation names an endpoint that accepts one.
 *
 * Guessing the header has an asymmetric cost. A wrong guess reports a VALID
 * token as invalid, and the operator concludes their token is bad — worse than
 * running no check at all, because a check that can only fail is not a check.
 * So this provider states plainly that it has not validated, and mt#5022's SC3
 * adds the real check once a token is in the store and the response can be
 * OBSERVED rather than predicted.
 *
 * What IS checked is the one error with a real consequence: pasting the
 * metered API key into the subscription field, which would silently bill the
 * wrong account for every run.
 */
import type { CredentialProvider, CredentialCheckResult } from "../types";

/**
 * Anthropic API keys carry this prefix. Used ONLY to catch a paste into the
 * wrong field — never to validate a subscription token, whose format is not
 * documented and must not be guessed at.
 */
const ANTHROPIC_API_KEY_PREFIX = "sk-ant-";

/**
 * The shortest plausible credential. Deliberately loose: this exists to catch
 * an empty or truncated paste, not to assert a format nobody has published.
 */
const MIN_TOKEN_LENGTH = 20;

const NOT_YET_VALIDATED_DETAIL =
  "stored; NOT checked against a live endpoint — no endpoint is known to accept " +
  "a subscription token, so no check is claimed (mt#5022 SC3)";

/**
 * Shape check only. Returns `ok: true` for anything that could be a token,
 * with a detail that says no live check ran — so a caller cannot read this as
 * a validation it is not.
 */
async function checkShape(token: string): Promise<CredentialCheckResult> {
  const trimmed = token.trim();

  if (trimmed.length === 0) {
    return { ok: false, detail: "empty — no token provided" };
  }

  if (trimmed.startsWith(ANTHROPIC_API_KEY_PREFIX)) {
    return {
      ok: false,
      detail:
        `that is an Anthropic API key (\`${ANTHROPIC_API_KEY_PREFIX}…\`), not a subscription ` +
        "token. Storing it here would bill API credits rather than the subscription — which " +
        "is the whole distinction this provider exists for. Use the `anthropic` provider for " +
        "an API key, or run `claude setup-token` for a subscription token.",
    };
  }

  if (trimmed.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      detail: `too short (${trimmed.length} chars) — looks truncated`,
    };
  }

  return { ok: true, detail: NOT_YET_VALIDATED_DETAIL };
}

export const claudeCodeTokenProvider: CredentialProvider = {
  id: "claude-code-token",
  displayName: "Claude Code (subscription token)",
  configPath: "ai.providers.anthropic.authToken",
  acquireUrl: "https://code.claude.com/docs/en/settings",
  scopeGuidance:
    "Run `claude setup-token` in a terminal — it mints a long-lived token and requires an " +
    "active Claude subscription. This bills the SUBSCRIPTION, not API credits; for a metered " +
    "API key use the `anthropic` provider instead. There are no scopes to select. Note that " +
    "this value is not verified against a live endpoint when stored — see mt#5022.",
  validate: checkShape,
  test: checkShape,
};
