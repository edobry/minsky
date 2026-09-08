/**
 * `credentialStatusLine` — the rule that decides what the providers table's
 * Detail column shows (mt#5031).
 *
 * This function is the structural guarantee the task rests on: the column can
 * only ever render what this returns, so a provider that supplies no `status`,
 * or a stored detail that is too long, cannot truncate the column. The cases
 * below are the ones that were actually wrong in production plus the boundary
 * each rung of the precedence exists to handle.
 *
 * The two long fixtures are the REAL strings, copied from a live
 * `GET /api/credentials` against the operator's cockpit — 84 and 95 characters,
 * measured at 465px and 523px against a 276px column. Using the real strings
 * rather than invented long ones is what makes the regression assertions mean
 * something: a future change that reintroduces "render the detail" fails here
 * with the exact text the principal reported.
 */
import { describe, expect, test } from "bun:test";
import {
  credentialStatusLine,
  isManaged,
  MAX_STATUS_LENGTH,
  type CredentialListing,
} from "./credentials-api";

/** The string the principal reported as cut off and weird. 84 chars. */
const CLAUDE_CODE_DETAIL =
  "saved — format matches; a subscription token can't be tested until something uses it";

/** Longer still, and an instruction rather than a state. 95 chars. */
const TELEGRAM_DETAIL =
  "token valid; no chats visible yet — send your bot one message so chat-id discovery can find you";

/** The status `claude-code-token` now supplies for the column. */
const STORED_UNVERIFIED = "stored, unverified";

/** A pre-split detail that is already state-shaped and inside the budget. */
const SHORT_DETAIL = "4 projects visible";

/** An arbitrary past check time; only its presence matters to the rule. */
const CHECKED_AT = "2026-09-08T05:00:00Z";

function listing(overrides: Partial<CredentialListing> = {}): CredentialListing {
  return {
    provider: "example",
    displayName: "Example",
    configPath: "example.token",
    configured: true,
    source: "provider",
    ...overrides,
  };
}

describe("credentialStatusLine", () => {
  test("the fixtures are the real over-budget strings, not invented ones", () => {
    // Liveness: if these ever shrink under the budget, the regression tests
    // below stop testing the thing they were written for and start passing for
    // the wrong reason.
    expect(CLAUDE_CODE_DETAIL.length).toBe(84);
    expect(TELEGRAM_DETAIL.length).toBe(95);
    expect(CLAUDE_CODE_DETAIL.length).toBeGreaterThan(MAX_STATUS_LENGTH);
    expect(TELEGRAM_DETAIL.length).toBeGreaterThan(MAX_STATUS_LENGTH);
  });

  test("rung 1: a provider's own status is used verbatim", () => {
    expect(
      credentialStatusLine(
        listing({
          lastValidationStatus: STORED_UNVERIFIED,
          lastValidationDetail: CLAUDE_CODE_DETAIL,
        })
      )
    ).toBe(STORED_UNVERIFIED);
  });

  test("rung 1 wins over a stored detail, however short that detail is", () => {
    expect(
      credentialStatusLine(
        listing({ lastValidationStatus: SHORT_DETAIL, lastValidationDetail: "whatever" })
      )
    ).toBe(SHORT_DETAIL);
  });

  test("rung 2: a presence-only schema row shows nothing", () => {
    // No provider module backs it, so no check has ever run. An empty cell is
    // the correct answer here — the row's own `config-only` marker says why.
    const row = listing({ source: "schema", configured: true });
    expect(credentialStatusLine(row)).toBeNull();
    expect(isManaged(row)).toBe(false);
  });

  test("rung 3: an unconfigured provider shows nothing", () => {
    // The Status column already says "Not configured".
    expect(credentialStatusLine(listing({ configured: false }))).toBeNull();
  });

  test("rung 4: a pre-split row keeps a SHORT detail rather than losing it", () => {
    // Back-compat. Every row written before this change has a detail and no
    // status, and most are already state-shaped. Dropping them all to a generic
    // "validated" would make the column worse for most rows to fix it for two.
    expect(
      credentialStatusLine(
        listing({ lastValidationDetail: SHORT_DETAIL, lastValidatedAt: CHECKED_AT })
      )
    ).toBe(SHORT_DETAIL);
  });

  test("rung 4 is bounded: a detail exactly at the budget still passes through", () => {
    const exact = "x".repeat(MAX_STATUS_LENGTH);
    expect(credentialStatusLine(listing({ lastValidationDetail: exact }))).toBe(exact);
  });

  test("rung 5: the two REAL over-budget details are never rendered", () => {
    // The regression this task exists to prevent, asserted with the exact text
    // that was on the principal's screen.
    for (const detail of [CLAUDE_CODE_DETAIL, TELEGRAM_DETAIL]) {
      const result = credentialStatusLine(
        listing({ lastValidationDetail: detail, lastValidatedAt: CHECKED_AT })
      );
      expect(result).toBe("validated");
      expect(result).not.toBe(detail);
    }
  });

  test("rung 5: configured but never checked is distinguishable from nothing to say", () => {
    // Anthropic's live row: `configured: true`, no detail, no timestamp. It
    // used to render an empty cell, indistinguishable from a schema row.
    expect(credentialStatusLine(listing({ lastValidationDetail: undefined }))).toBe(
      "configured, never checked"
    );
  });

  test("every value this can return fits the budget", () => {
    // The invariant the column depends on, swept across every branch rather
    // than asserted per-case — a new rung that returns something long fails
    // here even if its own test forgets to check.
    const cases: CredentialListing[] = [
      listing({ lastValidationStatus: STORED_UNVERIFIED }),
      listing({ source: "schema" }),
      listing({ configured: false }),
      listing({ lastValidationDetail: SHORT_DETAIL }),
      listing({ lastValidationDetail: CLAUDE_CODE_DETAIL, lastValidatedAt: CHECKED_AT }),
      listing({ lastValidationDetail: TELEGRAM_DETAIL }),
      listing({}),
    ];

    const overBudget = cases
      .map((row) => credentialStatusLine(row))
      .filter((line): line is string => line !== null && line.length > MAX_STATUS_LENGTH);

    expect(overBudget).toEqual([]);
  });
});
