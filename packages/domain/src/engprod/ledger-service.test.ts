/**
 * Tests for the proposal ledger's curation-gate decision logic (mt#3330).
 *
 * `decideShouldPropose`/`decideReconciliation` are pure functions extracted
 * from `ProposalLedgerService` specifically so this logic — the dedupe +
 * re-surface-threshold + acceptance-is-unblocking rules the spec's AT2/SC3
 * actually test — is verifiable without a database.
 */

import { describe, test, expect } from "bun:test";
import { decideShouldPropose, decideReconciliation } from "./ledger-service";
import type { ProposalLedgerRow } from "../storage/schemas/engprod-proposal-ledger-schema";

function ledgerRow(overrides: Partial<ProposalLedgerRow> = {}): ProposalLedgerRow {
  const now = new Date();
  return {
    clusterSignature: "sig-1",
    verdict: "rejected",
    rejectionReason: null,
    suppressedReason: null,
    toolSequence: ["Read", "Edit"],
    evidenceFrequency: 5,
    evidenceSessions: 2,
    evidenceChainLength: 2,
    evidenceSnapshot: {},
    filedTaskId: null,
    everProposed: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("decideShouldPropose", () => {
  test("proposes a cluster with no prior ledger row", () => {
    const decision = decideShouldPropose(null, { frequency: 3 });
    expect(decision.propose).toBe(true);
  });

  test("AT2: does not re-propose a rejected cluster at equal evidence", () => {
    const existing = ledgerRow({ verdict: "rejected", evidenceFrequency: 5 });
    const decision = decideShouldPropose(existing, { frequency: 5 });
    expect(decision.propose).toBe(false);
  });

  test("AT2: does not re-propose a rejected cluster below the doubling threshold", () => {
    const existing = ledgerRow({ verdict: "rejected", evidenceFrequency: 5 });
    const decision = decideShouldPropose(existing, { frequency: 9 }); // < 10
    expect(decision.propose).toBe(false);
  });

  test("AT2: re-proposes a rejected cluster once frequency at least doubles", () => {
    const existing = ledgerRow({ verdict: "rejected", evidenceFrequency: 5 });
    const decision = decideShouldPropose(existing, { frequency: 10 }); // exactly 2x
    expect(decision.propose).toBe(true);
  });

  test("does not re-propose an already-accepted cluster", () => {
    const existing = ledgerRow({ verdict: "accepted" });
    expect(decideShouldPropose(existing, { frequency: 999 }).propose).toBe(false);
  });

  test("does not re-propose a superseded cluster", () => {
    const existing = ledgerRow({ verdict: "superseded" });
    expect(decideShouldPropose(existing, { frequency: 999 }).propose).toBe(false);
  });

  test("does not re-propose a still-pending proposed cluster", () => {
    const existing = ledgerRow({ verdict: "proposed" });
    expect(decideShouldPropose(existing, { frequency: 999 }).propose).toBe(false);
  });

  test("always re-competes a budget-suppressed cluster, no doubling required", () => {
    const existing = ledgerRow({ verdict: "suppressed", evidenceFrequency: 100 });
    // Same evidence, no doubling — still eligible (mechanical cut, not a rejection).
    expect(decideShouldPropose(existing, { frequency: 100 }).propose).toBe(true);
  });
});

describe("decideReconciliation", () => {
  test("no-change while the task is still BLOCKED", () => {
    expect(decideReconciliation("BLOCKED")).toBe("no-change");
  });

  test("no-change when the task cannot be found (transient gap)", () => {
    expect(decideReconciliation(undefined)).toBe("no-change");
  });

  test("rejected when the task was CLOSED without ever being unblocked", () => {
    expect(decideReconciliation("CLOSED")).toBe("rejected");
  });

  test("SC3: accepted for any status other than BLOCKED/CLOSED (unblocking)", () => {
    for (const status of ["TODO", "PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW", "DONE"]) {
      expect(decideReconciliation(status)).toBe("accepted");
    }
  });
});
