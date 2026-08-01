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
import { parseTaskTags, checkProposalGuard, validateRejectionReason } from "./engprod-proposals";

/** Shared fixture: the JSON-serialized tags column value for a tagged proposal task. */
const PROPOSAL_TAGS_JSON = JSON.stringify(["engprod-proposal"]);

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

  test("tagged proposal task not currently BLOCKED -> conflict, carrying its status", () => {
    expect(checkProposalGuard({ status: "TODO", tags: PROPOSAL_TAGS_JSON })).toEqual({
      kind: "conflict",
      status: "TODO",
    });
  });

  test("a null status reports as 'unknown' in the conflict, never a bare null", () => {
    expect(checkProposalGuard({ status: null, tags: PROPOSAL_TAGS_JSON })).toEqual({
      kind: "conflict",
      status: "unknown",
    });
  });

  test("tagged proposal task currently BLOCKED -> ok", () => {
    expect(checkProposalGuard({ status: "BLOCKED", tags: PROPOSAL_TAGS_JSON })).toEqual({
      kind: "ok",
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
