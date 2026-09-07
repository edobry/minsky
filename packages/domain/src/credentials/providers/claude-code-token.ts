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
 *
 * ## The paragraph above was written, and then violated, in the same file
 *
 * The original check tested `sk-ant-` — the FAMILY prefix both credentials
 * share — and so rejected every subscription token. The operator pasted a real
 * one and was told it was an API key (mt#5023). The reasoning that produced it
 * is worth keeping visible: the format of a subscription token was treated as
 * unknowable and left unchecked, while the format of an API key was treated as
 * known and checked. Both were guesses; only one was labelled as one.
 *
 * The general shape, for whoever edits this next: a check you are confident
 * about deserves the same sourcing as the one you declined to write.
 */
import type { CredentialProvider, CredentialCheckResult } from "../types";

/**
 * `sk-ant-` is the FAMILY prefix, shared by both credentials — it discriminates
 * nothing. The kind is carried by the segment after it: `api03` for a Console
 * API key, `oat01` for the OAuth access token `claude setup-token` mints.
 *
 * Testing the family prefix rejected exactly the credential this provider
 * exists to hold, which is how it shipped (mt#5023): the operator pasted a real
 * subscription token and was told it was an API key. Match the SEGMENT.
 */
const API_KEY_SEGMENT = /^sk-ant-api\d*-/;
const SUBSCRIPTION_TOKEN_SEGMENT = /^sk-ant-oat\d*-/;

/**
 * The shortest plausible credential. Deliberately loose: this exists to catch
 * an empty or truncated paste, not to assert a length nobody has published.
 */
const MIN_TOKEN_LENGTH = 20;

const NOT_YET_VALIDATED_DETAIL =
  "stored; NOT checked against a live endpoint — knowing the FORMAT does not tell " +
  "us what accepts it, so no check is claimed (mt#5022 SC3)";

/**
 * An `sk-ant-` value matching neither known segment. ACCEPTED, deliberately:
 * refusing a shape Anthropic may add is the same error as refusing `oat01`
 * was, one format later. Say it is unrecognized; do not block on it.
 */
const UNRECOGNIZED_SHAPE_DETAIL =
  "stored; the shape is not one this provider recognizes (neither `sk-ant-api…` " +
  "nor `sk-ant-oat…`). Accepted rather than refused — a format we do not know is " +
  "not a format that is wrong (mt#5023 SC3)";

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

  if (API_KEY_SEGMENT.test(trimmed)) {
    return {
      ok: false,
      detail:
        "that is an Anthropic API key (`sk-ant-api…`), not a subscription token. Storing it " +
        "here would bill API credits rather than the subscription — which is the whole " +
        "distinction this provider exists for. Use the `anthropic` provider for an API key, " +
        "or run `claude setup-token` for a subscription token (`sk-ant-oat…`).",
    };
  }

  if (trimmed.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      detail: `too short (${trimmed.length} chars) — looks truncated`,
    };
  }

  return {
    ok: true,
    detail: SUBSCRIPTION_TOKEN_SEGMENT.test(trimmed)
      ? NOT_YET_VALIDATED_DETAIL
      : UNRECOGNIZED_SHAPE_DETAIL,
  };
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
