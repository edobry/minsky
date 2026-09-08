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
 * The two quantifiers differ, and the difference is the point — an ACCEPT
 * predicate and a REJECT predicate have opposite safe directions:
 *
 *   - `SUBSCRIPTION_TOKEN_SEGMENT` decides what gets STORED, so loose is
 *     dangerous. `\d+` requires at least one version digit, matching every
 *     token ever observed (`oat01`) and tolerating a version bump (`oat02`)
 *     without also admitting a version-less `sk-ant-oat-` that no one has seen.
 *   - `API_KEY_SEGMENT` decides which REFUSAL MESSAGE an already-refused value
 *     gets, so loose is safe. `\d*` also catches a hypothetical `sk-ant-api-`,
 *     which then gets the billing-specific message instead of the generic
 *     one. Tightening it could only make an error message worse, never let
 *     something through — the shape gate below refuses it either way.
 *
 * Neither is a wildcard over the segment itself: a different segment is a
 * different KIND of credential, and this provider holds one kind.
 */
const API_KEY_SEGMENT = /^sk-ant-api\d*-/;
const SUBSCRIPTION_TOKEN_SEGMENT = /^sk-ant-oat\d+-/;

/**
 * Floor for a token that already matched the shape — so this catches a
 * truncated paste of a REAL token, and never speaks to a value that is not a
 * subscription token at all (that one gets the shape message; "too short"
 * would send someone who pasted the wrong secret looking for a longer wrong
 * secret).
 *
 * DERIVATION, because a number picked by feel is what put 20 here: the only
 * length ever observed is 108 — `sk-ant-oat01-` (13) plus a 95-char body. Half
 * that body is ~48, so 13 + 48 ≈ 60. A paste that lost more than half its body
 * is a truncation by any reading.
 *
 * NOT set to ~108, deliberately, and this is the asymmetry that governs the
 * whole file: refusing a real credential has a victim (mt#5022 did exactly
 * that), while storing an obviously truncated one costs a confusing auth error
 * at first use. The 108 figure is `strong-evidence` from third-party
 * write-ups, not Anthropic's own reference, so a floor pinned to it would
 * convert any shorter real variant into the mt#5022 failure. 60 leaves a real
 * token ~1.8x headroom. Raise it if a primary source ever fixes the length.
 */
const MIN_TOKEN_LENGTH = 60;

/**
 * The success message, in the register every sibling provider already uses:
 * `authenticated as @octocat`, `3 projects visible`, `12 models accessible`.
 * Short, and a RESULT rather than an argument.
 *
 * It carries the two facts a person needs here — the value was saved, and it is
 * unverified. The REASON it is unverified (no endpoint is known to accept a
 * subscription token; mt#5022 SC3 owns adding a real check once one is) belongs
 * in this comment and the docblock above, which is where it now lives.
 *
 * What it replaced argued for its own design and cited a task id and a
 * success-criterion number at the reader. The operator being a developer does
 * not make `mt#5022 SC3` useful in a dialog — "would understand it" and "is
 * served by it" are different tests, and only the second one is the bar for
 * copy a user reads (mt#5027).
 */
const NOT_YET_VALIDATED_DETAIL =
  "saved — format matches; a subscription token can't be tested until something uses it";

/**
 * The same fact as a STATE, for the providers table's Detail column.
 *
 * This string is the one the principal actually hit. The detail above is
 * correct where it was designed to be shown — inline, immediately after you
 * press Add — and wrong in a column that is 276px wide and read as a status:
 * it was truncated to about 59% of itself, and "saved" reports an EVENT where
 * a column wants a CONDITION.
 *
 * The previous correction shortened the sentence, which could not have fixed
 * this: at ~13 words it satisfied the word bound it was given and still needed
 * 465px. The unit was wrong, and so was the assumption that one string could
 * serve both surfaces.
 *
 * "stored" is what is true of the credential; "unverified" is what is not yet
 * true of it. Neither claims a check that did not run.
 */
const NOT_YET_VALIDATED_STATUS = "stored, unverified";

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
        "that's an Anthropic API key (`sk-ant-api…`), not a subscription token — storing it " +
        "here would bill API credits instead of your subscription. Use the `anthropic` " +
        "provider for an API key, or run `claude setup-token` for a subscription one.",
    };
  }

  if (!SUBSCRIPTION_TOKEN_SEGMENT.test(trimmed)) {
    return {
      ok: false,
      // Operator-facing: what is wrong, what the right thing looks like, how to
      // get one, and that nothing was written. The reasoning for refusing
      // rather than storing-with-a-caveat belongs in the docblock above, not in
      // a dialog — a message that argues with the reader is a worse message.
      detail:
        "not a Claude subscription token — those start `sk-ant-oat…`. Run `claude setup-token` " +
        "to get one; it needs an active Claude subscription. Nothing was saved.",
    };
  }

  if (trimmed.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      detail: `too short (${trimmed.length} chars) — looks truncated`,
    };
  }

  return { ok: true, detail: NOT_YET_VALIDATED_DETAIL, status: NOT_YET_VALIDATED_STATUS };
}

export const claudeCodeTokenProvider: CredentialProvider = {
  id: "claude-code-token",
  displayName: "Claude Code (subscription token)",
  configPath: "ai.providers.anthropic.authToken",
  acquireUrl: "https://code.claude.com/docs/en/settings",
  scopeGuidance:
    "Run `claude setup-token` in a terminal — it creates a long-lived token (`sk-ant-oat…`) and " +
    "needs an active Claude subscription. This bills the SUBSCRIPTION, not API credits; for " +
    "a metered API key use the `anthropic` provider instead. There are no scopes to select. " +
    "Note that this value is not verified when saved — nothing here can test a subscription " +
    "token, so a bad one shows up the first time something tries to use it.",
  validate: checkShape,
  test: checkShape,
};
