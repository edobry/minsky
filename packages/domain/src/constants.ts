/**
 * Shared domain constants
 *
 * Centralizes string literals that are referenced across multiple domain modules
 * to ensure consistent identity and avoid scattered magic strings.
 */

/**
 * The GitHub login name of the Minsky bot identity.
 * Centralised here so future renames touch one place.
 *
 * Used in session merge operations (waiver eligibility checks) and any other
 * domain code that needs to identify the bot author identity.
 */
export const BOT_IDENTITY_LOGIN = "minsky-ai[bot]";

/**
 * The GitHub login name of the Minsky reviewer bot.
 * Centralised here alongside BOT_IDENTITY_LOGIN so future renames touch one place.
 *
 * Used in the acceptStaleReviewerSilence waiver logic to detect whether the
 * reviewer bot has already acted on a PR.
 */
export const REVIEWER_BOT_LOGIN = "minsky-reviewer[bot]";
