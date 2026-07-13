/**
 * Bot-identity resolution (mt#2392).
 *
 * Minsky's merge/review logic historically compared GitHub logins against the
 * hard-coded `BOT_IDENTITY_LOGIN` / `REVIEWER_BOT_LOGIN` constants, so the
 * merge-gate waiver path could never be satisfied for any project not running
 * Minsky's own GitHub Apps. This module resolves the identities from
 * configuration with the constants as defaults:
 *
 *   - implementer bot: `github.botIdentityLogin` ← `MINSKY_GITHUB_BOT_IDENTITY_LOGIN`
 *     (default: `BOT_IDENTITY_LOGIN`, "minsky-ai[bot]")
 *   - reviewer bot:    `reviewer.botLogin`       ← `MINSKY_REVIEWER_BOT_LOGIN`
 *     (default: `REVIEWER_BOT_LOGIN`, "minsky-reviewer[bot]")
 *
 * Absent-bot semantics (the defined fallback, decided in mt#2392): when
 * NEITHER key is configured, the Minsky-default identities apply — identical
 * behavior to the pre-mt#2392 constants, which keeps Minsky's own repo working
 * with zero config. For an external project this means the waiver path stays
 * inapplicable (its PR authors won't match the Minsky bots) and the merge gate
 * falls back to standard GitHub branch-protection approvals — i.e. human
 * review. The waiver-condition error messages name the resolved identity AND
 * the config keys, so an external operator hitting the mismatch learns how to
 * configure their own bots instead of facing a silently-never-satisfied gate.
 *
 * The constants themselves remain exported from `../constants` — the reviewer
 * service (`services/reviewer/src/github-client.ts`,
 * `prior-review-summary.ts`) imports them directly as Minsky's own deployed
 * identities; do not retire them.
 */

import { BOT_IDENTITY_LOGIN, REVIEWER_BOT_LOGIN } from "../constants";
import { getConfiguration } from "./index";

export interface ResolvedBotIdentities {
  /** GitHub login of the implementer bot (PR author the waiver recognizes). */
  botIdentityLogin: string;
  /** GitHub login of the reviewer bot (whose reviews satisfy the merge gate). */
  reviewerBotLogin: string;
  /**
   * True when at least one identity was explicitly configured (config file or
   * env). False means both fell back to the Minsky-default constants.
   */
  explicitlyConfigured: boolean;
}

/**
 * Minimal structural slice of the resolved config this module reads. Accepting
 * the slice (rather than the full ResolvedConfig) keeps the resolver testable
 * without constructing a complete configuration object.
 */
export interface BotIdentityConfigSlice {
  github?: { botIdentityLogin?: string };
  reviewer?: { botLogin?: string };
}

/**
 * Resolve the implementer/reviewer bot logins from configuration, falling back
 * to Minsky's own App identities.
 *
 * When `cfg` is omitted, reads the live configuration via `getConfiguration()`.
 * If configuration is unavailable (e.g. unit-test contexts that never
 * initialize the config system), the resolver degrades to the constant
 * defaults rather than throwing — identity resolution must never be the reason
 * a merge crashes.
 */
export function resolveBotIdentities(cfg?: BotIdentityConfigSlice): ResolvedBotIdentities {
  let slice: BotIdentityConfigSlice | undefined = cfg;
  if (slice === undefined) {
    try {
      slice = getConfiguration() as BotIdentityConfigSlice;
    } catch {
      slice = undefined;
    }
  }

  const configuredImplementer = slice?.github?.botIdentityLogin?.trim();
  const configuredReviewer = slice?.reviewer?.botLogin?.trim();

  return {
    botIdentityLogin: configuredImplementer || BOT_IDENTITY_LOGIN,
    reviewerBotLogin: configuredReviewer || REVIEWER_BOT_LOGIN,
    explicitlyConfigured: Boolean(configuredImplementer || configuredReviewer),
  };
}
