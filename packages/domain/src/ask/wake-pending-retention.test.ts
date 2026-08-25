/**
 * Pins the delivered-row retention window and its derivation (mt#4541, PR #3321 R1).
 *
 * ## Why a test for a constant
 *
 * This number is not arbitrary and it is not local. It is derived from a ceiling declared
 * in a DIFFERENT module graph — `ENTRY_MAX_AGE_MS` in `.minsky/hooks/ask-conversation-map.ts`,
 * which `packages/domain` cannot import — so nothing mechanical links the two. Before
 * mt#4541 the window was that ceiling DOUBLED, to cover the gap between a ceiling that was
 * declared and one that was enforced; mt#4541 enforced it on the read path and the doubling
 * lost its job.
 *
 * A constant whose justification lives in another module graph is exactly the kind that
 * drifts silently: changing it breaks no type, fails no test, and produces no error — it
 * just deletes rows at a different time. These assertions make a change to it fail loudly
 * and force the reason to be restated.
 *
 * ## What this file does NOT cover, and where that lives
 *
 * The sweep's BOUNDARY BEHAVIOUR — a delivered row older than the window deleted, one inside
 * it retained, both measured against `drained_at` rather than `emitted_at` — is covered by
 * `tests/integration/wake-pending-retention.testcontainer.integration.test.ts`, which derives
 * `OUTSIDE_WINDOW` / `INSIDE_WINDOW` from this very constant (`:53-54`) and asserts both
 * directions against a real Postgres (`AT1: deletes old-delivered and addressee-gone rows,
 * keeps the other two`, `:223`; and `AT3/SC5`, `:289`).
 *
 * That derivation is why it cannot substitute for this file: a test whose fixtures come from
 * the constant follows the constant wherever it goes, so it proves the sweep HONORS the
 * window and is silent about whether the window is RIGHT. The two files answer different
 * questions and neither is redundant.
 */
import { describe, expect, test } from "bun:test";

import { WAKE_PENDING_DELIVERED_RETENTION_MS } from "./wake-pending-retention";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `ENTRY_MAX_AGE_MS` from `.minsky/hooks/ask-conversation-map.ts`, restated because the
 * hooks tree is a separate module graph this package must not import. If that constant
 * changes, this test keeps passing and the derivation below silently stops being true —
 * which is the residual risk, and the reason the hooks-side docblock names this file's
 * constant in return. A future mechanical link would be a real improvement.
 */
const ATTRIBUTION_CEILING_MS = 7 * ONE_DAY_MS;

describe("WAKE_PENDING_DELIVERED_RETENTION_MS", () => {
  test("is 8 days", () => {
    expect(WAKE_PENDING_DELIVERED_RETENTION_MS).toBe(8 * ONE_DAY_MS);
  });

  test("equals the enforced attribution ceiling plus exactly one day of skew margin", () => {
    // The derivation, asserted rather than described: 7d is the window after which
    // `readAskConversationMap` stops returning an attribution, so a wake row for an ask
    // past it can no longer be re-announced. The extra day covers clock skew between the
    // hook host (which stamps `recordedAt`) and Postgres (which stamps `drained_at`).
    expect(WAKE_PENDING_DELIVERED_RETENTION_MS).toBe(ATTRIBUTION_CEILING_MS + ONE_DAY_MS);
  });

  test("is strictly greater than the attribution ceiling it is derived from", () => {
    // The load-bearing inequality. If the window ever fell to or below the ceiling, a
    // delivered row could be deleted while the hook still tracks its ask — and the
    // `wakeDeliveredAt` suppression would vanish, re-announcing an answer the agent
    // already received. That is the failure this margin exists to prevent, and it is
    // worth asserting as an ordering rather than only as an arithmetic identity: the
    // identity above pins today's value, this pins what must remain true of any value.
    expect(WAKE_PENDING_DELIVERED_RETENTION_MS).toBeGreaterThan(ATTRIBUTION_CEILING_MS);
  });

  test("is shorter than the window it replaced, so mt#4541 was a reduction", () => {
    // Guards the direction of the mt#4541 change specifically: the old value was the
    // ceiling doubled (14 days), kept only because the ceiling was unenforced. A revert
    // to it should be a deliberate act with a stated reason, not a silent regression.
    expect(WAKE_PENDING_DELIVERED_RETENTION_MS).toBeLessThan(2 * ATTRIBUTION_CEILING_MS);
  });
});
