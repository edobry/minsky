/**
 * Tests for the pure guard/validation helpers backing the EngProd proposal
 * accept/reject endpoints (mt#3331). The route handler itself calls
 * `getServerEngprodDb()` / `getServerTaskService()` directly (no DI seam —
 * matching the existing untested-at-this-layer convention documented in
 * `tasks.test.ts`'s header) and runs a real `db.transaction()`, so the
 * DECISION rules (not-found / wrong-tag / already-actioned / reason
 * validation) are extracted into pure functions and tested directly here,
 * mirroring `ledger-service.ts`'s `decideShouldPropose`/`decideReconciliation`
 * pattern.
 */
import { describe, test, expect } from "bun:test";
import { ENGPROD_ACCEPTED_TAG, ENGPROD_PROPOSAL_TAG } from "@minsky/domain/engprod/types";
import {
  acceptedTaskRow,
  parseTaskTags,
  checkProposalGuard,
  validateRejectionReason,
} from "./engprod-proposals";

/** Shared fixture: the JSON-serialized tags column value for a tagged proposal task. */
const PROPOSAL_TAGS_JSON = JSON.stringify([ENGPROD_PROPOSAL_TAG]);

describe("parseTaskTags", () => {
  test("parses a JSON-serialized tag array", () => {
    expect(parseTaskTags('["engprod-proposal","other"]')).toEqual(["engprod-proposal", "other"]);
  });

  test("null/undefined -> empty array", () => {
    expect(parseTaskTags(null)).toEqual([]);
    expect(parseTaskTags(undefined)).toEqual([]);
  });

  test("malformed JSON degrades to empty array rather than throwing", () => {
    expect(parseTaskTags("not json")).toEqual([]);
  });

  test("a non-array JSON value degrades to empty array", () => {
    expect(parseTaskTags('{"not":"an array"}')).toEqual([]);
  });

  test("filters out non-string array entries", () => {
    expect(parseTaskTags('["a", 1, null, "b"]')).toEqual(["a", "b"]);
  });
});

describe("checkProposalGuard", () => {
  test("missing task row -> not-found", () => {
    expect(checkProposalGuard(undefined)).toEqual({ kind: "not-found" });
  });

  test("task exists but lacks the engprod-proposal tag -> not-a-proposal", () => {
    expect(checkProposalGuard({ status: "BLOCKED", tags: '["some-other-tag"]' })).toEqual({
      kind: "not-a-proposal",
    });
  });

  test("pending proposal (TODO + engprod-proposal, the post-mt#5130 filed shape) -> ok", () => {
    expect(checkProposalGuard({ status: "TODO", tags: PROPOSAL_TAGS_JSON })).toEqual({
      kind: "ok",
      tags: [ENGPROD_PROPOSAL_TAG],
    });
  });

  test("a not-yet-migrated BLOCKED proposal is still pending -> ok", () => {
    expect(checkProposalGuard({ status: "BLOCKED", tags: PROPOSAL_TAGS_JSON })).toEqual({
      kind: "ok",
      tags: [ENGPROD_PROPOSAL_TAG],
    });
  });

  test("already accepted (tag swapped) -> conflict naming the disposition", () => {
    expect(
      checkProposalGuard({ status: "TODO", tags: JSON.stringify([ENGPROD_ACCEPTED_TAG]) })
    ).toEqual({ kind: "conflict", disposition: "accepted" });
  });

  test("already rejected (CLOSED) -> conflict naming the disposition", () => {
    expect(checkProposalGuard({ status: "CLOSED", tags: PROPOSAL_TAGS_JSON })).toEqual({
      kind: "conflict",
      disposition: "rejected",
    });
  });

  test("a planned proposal still carrying the pending tag may be actioned (a null status too)", () => {
    expect(checkProposalGuard({ status: "PLANNING", tags: PROPOSAL_TAGS_JSON })).toEqual({
      kind: "ok",
      tags: [ENGPROD_PROPOSAL_TAG],
    });
    expect(checkProposalGuard({ status: null, tags: PROPOSAL_TAGS_JSON })).toEqual({
      kind: "ok",
      tags: [ENGPROD_PROPOSAL_TAG],
    });
  });

  test("acceptedTaskRow: swaps the tag and keeps the status — except a legacy BLOCKED row, lifted to TODO (PR #3746 R1)", () => {
    expect(acceptedTaskRow("TODO", [ENGPROD_PROPOSAL_TAG, "other"])).toEqual({
      status: "TODO",
      tags: ["other", ENGPROD_ACCEPTED_TAG],
    });
    expect(acceptedTaskRow("PLANNING", [ENGPROD_PROPOSAL_TAG])).toEqual({
      status: "PLANNING",
      tags: [ENGPROD_ACCEPTED_TAG],
    });
    // A proposal filed before mt#5130 and not yet migrated must not stay in
    // the retired containment state once accepted.
    expect(acceptedTaskRow("BLOCKED", [ENGPROD_PROPOSAL_TAG])).toEqual({
      status: "TODO",
      tags: [ENGPROD_ACCEPTED_TAG],
    });
  });

  test("the guard hands back the parsed tags so Accept can swap without re-parsing", () => {
    const tags = JSON.stringify([ENGPROD_PROPOSAL_TAG, "other"]);
    expect(checkProposalGuard({ status: "TODO", tags })).toEqual({
      kind: "ok",
      tags: [ENGPROD_PROPOSAL_TAG, "other"],
    });
  });
});

describe("validateRejectionReason (spec requirement #4: reason required)", () => {
  test("a non-empty string reason -> ok, trimmed", () => {
    expect(validateRejectionReason({ reason: "  duplicate of mt#123  " })).toEqual({
      ok: true,
      reason: "duplicate of mt#123",
    });
  });

  test("missing reason field -> not ok", () => {
    expect(validateRejectionReason({})).toEqual({ ok: false });
  });

  test("empty string reason -> not ok", () => {
    expect(validateRejectionReason({ reason: "" })).toEqual({ ok: false });
  });

  test("whitespace-only reason -> not ok", () => {
    expect(validateRejectionReason({ reason: "   " })).toEqual({ ok: false });
  });

  test("a non-string reason (malformed body) -> not ok", () => {
    expect(validateRejectionReason({ reason: 42 })).toEqual({ ok: false });
  });

  test("null/undefined body -> not ok", () => {
    expect(validateRejectionReason(null)).toEqual({ ok: false });
    expect(validateRejectionReason(undefined)).toEqual({ ok: false });
  });
});
