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
 * `x-api-key` header. A subscription token is not an API key and is rejected by
 * the Messages API; nothing in Anthropic's published settings documentation
 * names an endpoint that accepts one.
 *
 * Guessing the header has an asymmetric cost. A wrong guess reports a VALID
 * token as invalid, and the operator concludes their token is bad — worse than
 * running no check at all, because a check that can only fail is not a check.
 * So this provider states plainly that it has not validated, and mt#5022's SC3
 * adds the real check once a token is in the store and the response can be
 * OBSERVED rather than predicted.
 *
 * ## What `validate` MEANS here, which is why the shape check is a gate
 *
 * `CredentialProvider.validate` is documented in `../types.ts` as *"Called
 * BEFORE persisting. A 401 here means 'do not store'."* So `ok` is not an
 * advisory grade on the value — it is the decision to write it to the
 * credential store. There is no third answer available: a value this provider
 * cannot recognize as the one credential type it holds is refused, because the
 * only alternative the contract offers is storing it.
 *
 * ## Two corrections got here, from opposite directions
 *
 * The check has been wrong twice, and reading only the nearer of the two is how
 * the second one happened.
 *
 * mt#5023 fixed the FIRST: the original check tested `sk-ant-` — the FAMILY
 * prefix both credentials share — and so rejected every subscription token. The
 * operator pasted a real one and was told it was an API key. That fix was
 * correct.
 *
 * mt#5026 fixed the SECOND, which the first one introduced: an unrecognized
 * shape was ACCEPTED with a note, on the reasoning that refusing a format
 * Anthropic might add is "the same class of error" as refusing `oat01` was. It
 * is not the same class. The first error refused a real credential the operator
 * was holding; the second accepted arbitrary text into a credential store — the
 * operator typed gibberish into the cockpit and it validated. One had a victim;
 * the other guarded a hypothetical future format that costs one line to add
 * whenever it actually appears.
 *
 * The general shape, for whoever edits this next — two rules, and the second is
 * the one that is easy to miss:
 *
 *   1. A check you are confident about deserves the same sourcing as the one
 *      you declined to write.
 *   2. After a correction, check whether you have restated the requirement or
 *      merely inverted the last mistake. An inversion looks like a fix from
 *      inside, because it is argued entirely from the failure it follows. The
 *      requirement here is not "be less strict than mt#5022" — it is "hold one
 *      credential type, and be able to tell whether you have one."
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
 *
 * SOURCE for `oat` (mem#968 — a literal restating an EXTERNAL vendor's format
 * binds to a cited source or a real sample, never to recall): the operator's
 * own `claude setup-token` output, pasted into the cockpit and observed to
 * begin `sk-ant-oat01-`; corroborated by `anthropics/claude-code-action` issue
 * #1316, titled "claude_code_oauth_token (sk-ant-oat01-*) fails with Header 14
 * invalid value".
 *
 * `\d*` tolerates the VERSION digits, which vary within the token kind
 * (`oat01` → `oat02`). It is deliberately not a wildcard over the segment
 * itself: a different segment is a different KIND of credential, and this
 * provider holds one kind.
 */
const API_KEY_SEGMENT = /^sk-ant-api\d*-/;
const SUBSCRIPTION_TOKEN_SEGMENT = /^sk-ant-oat\d*-/;

/**
 * The shortest plausible credential. Deliberately loose: this exists to catch a
 * truncated paste of a REAL token, not to assert a length nobody has published
 * — which is why it is checked only AFTER the shape matches. A value that is
 * not a subscription token at all gets the shape message; "too short" would be
 * a misleading thing to tell someone who pasted the wrong kind of secret.
 */
const MIN_TOKEN_LENGTH = 20;

const NOT_YET_VALIDATED_DETAIL =
  "stored; NOT checked against a live endpoint — knowing the FORMAT does not tell " +
  "us what accepts it, so no check is claimed (mt#5022 SC3)";

/**
 * Shape check only. `ok: true` means "this looks like the credential this
 * provider holds, store it", with a detail that says no live check ran — so a
 * caller cannot read it as a validation it is not.
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

  if (!SUBSCRIPTION_TOKEN_SEGMENT.test(trimmed)) {
    return {
      ok: false,
      detail:
        "not a Claude subscription token — those start `sk-ant-oat…`. Run `claude setup-token` " +
        "to mint one; it requires an active Claude subscription. Nothing was stored: this " +
        "provider holds exactly one credential type, so a value it cannot recognize as that " +
        "type is refused rather than kept with a caveat (mt#5026).",
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
    "Run `claude setup-token` in a terminal — it mints a long-lived token (`sk-ant-oat…`) and " +
    "requires an active Claude subscription. This bills the SUBSCRIPTION, not API credits; for " +
    "a metered API key use the `anthropic` provider instead. There are no scopes to select. " +
    "Note that this value is not verified against a live endpoint when stored — see mt#5022.",
  validate: checkShape,
  test: checkShape,
};
