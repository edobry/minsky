/**
 * Canonical vocabulary for "approval" values on `authorization.approve` Asks
 * (mt#3203).
 *
 * This is the SINGLE source of truth for what counts as an approve-shaped
 * token. Two independent surfaces need to agree on it:
 *
 *   - Redemption time: `.minsky/hooks/ask-verification.ts`'s
 *     `isApprovingPayload` — the guard-override verifier that decides
 *     whether an operator's response to an `authorization.approve` Ask
 *     counts as approval.
 *   - Authoring time: `asks_create`'s option validation — which rejects an
 *     `authorization.approve` Ask whose options contain no approve-shaped
 *     `value`, so the footgun is caught before the Ask is ever routed
 *     instead of surfacing as a confusing "not approved" error at merge
 *     time after the operator already approved.
 *
 * A second, independently-maintained copy of this regex in either file is
 * exactly how mt#3203 happened in the first place: the verifier's
 * vocabulary silently drifted out of the authoring path's awareness, so a
 * descriptive button label (e.g. "Approve the override and merge") became
 * an unverifiable "approval" once `asks_create` defaulted the option's
 * `value` to its `label`. Both surfaces MUST import from here — never
 * redefine the pattern locally.
 *
 * Lives in `packages/shared` (not `packages/domain`) so it can be imported
 * by BOTH sides without a layering violation: `.minsky/hooks/*` are
 * self-contained scripts that avoid importing `src/` (`.minsky/hooks/SPEC.md`)
 * but already depend on `@minsky/shared` elsewhere (e.g.
 * `record-subagent-invocation.ts` imports `@minsky/shared/safe-truncate`),
 * and `packages/domain` already declares `@minsky/shared` as a dependency —
 * so neither side needs to reach across a boundary it doesn't already cross.
 */

/**
 * Tokens that count as approval when they appear as a response/option
 * VALUE. Deliberately narrow — see `.minsky/hooks/ask-verification.ts`'s
 * `isApprovingPayload` doc for why a value must be one of these exact
 * tokens rather than resolved against an option list.
 */
export const APPROVAL_TOKEN = /^(approved?|yes)$/i;

/** Human-readable examples of accepted tokens, for warning/error messages. */
export const APPROVAL_TOKEN_EXAMPLES = ["approve", "approved", "yes"] as const;

/**
 * True when `value` is itself one of the approve-shaped tokens.
 *
 * This checks the token in isolation — it does not resolve a `{chosen}`-
 * style value against any option list. That distinction matters: the
 * verifier's `isApprovingPayload` deliberately refuses to treat "the
 * operator chose SOME option" as approval, because that would make
 * declining an authorization Ask read as approving it.
 */
export function isApproveShapedToken(value: unknown): boolean {
  return typeof value === "string" && APPROVAL_TOKEN.test(value.trim());
}
