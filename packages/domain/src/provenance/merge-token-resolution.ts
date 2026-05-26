/**
 * Merge-time token selection for tier-aware PR merges.
 *
 * Decides whether a PR merge should be issued with the bot's service token
 * or the user's PAT, based on the authorship tier recorded for the PR and
 * whether a GitHub App service account is configured.
 *
 * This is a pure function: no I/O, no config lookups, no side effects. All
 * inputs are explicit arguments. Extracted from `session-merge-operations.ts`
 * so the token-routing decision can be tested exhaustively across all four
 * tier states (including the `null`/"no record" case that caused mt#992).
 *
 * @see mt#992 — missing-provenance fall-through bug
 * @see mt#846 — authorship tier model
 */

import { AuthorshipTier } from "./types";

/**
 * Decide which token to use for a PR merge API call.
 *
 * Decision table:
 *
 * | Service account configured | Tier                    | Token    | Reason                                    |
 * |----------------------------|-------------------------|----------|-------------------------------------------|
 * | false                      | any                     | "user"   | No alternative; PAT is the only path      |
 * | true                       | null                    | "user"   | Conservative default (mt#992)             |
 * | true                       | HUMAN_AUTHORED (tier 1) | "user"   | Human drove the work; human merges        |
 * | true                       | CO_AUTHORED (tier 2)    | "user"   | Shared authorship; human merges           |
 * | true                       | AGENT_AUTHORED (tier 3) | "service"| Agent drove the work; bot merges          |
 *
 * The `null` case is the mt#992 fix. Previously, code that only set a token
 * override when tier was known fell through to the default service token
 * when provenance was missing, causing permission failures on protected
 * branches where the bot lacks merge rights. Treating missing provenance
 * as equivalent to CO_AUTHORED is the conservative choice: it preserves
 * correct routing for every PR that was opened before the provenance
 * system existed or where record creation failed non-fatally.
 */
export function resolveMergeToken(
  tier: AuthorshipTier | null,
  serviceAccountConfigured: boolean
): "service" | "user" {
  if (!serviceAccountConfigured) return "user";
  if (tier === null) return "user";
  return tier === AuthorshipTier.AGENT_AUTHORED ? "service" : "user";
}
