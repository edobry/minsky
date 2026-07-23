import { describe, test, expect } from "bun:test";
import {
  isApprovingPayload,
  evaluateAskRows,
  verifyApprovedAsk,
  type AskRow,
  type ExecFn,
} from "./ask-verification";

const ASK_ID = "38b1c0de-1234-4abc-8def-000000000001";

const approvedRow = (overrides: Partial<AskRow> = {}): AskRow => ({
  id: ASK_ID,
  kind: "authorization.approve",
  state: "responded",
  response: { responder: "operator", payload: { approved: true } },
  ...overrides,
});

describe("isApprovingPayload", () => {
  test("approving shapes", () => {
    expect(isApprovingPayload({ approved: true })).toBe(true);
    expect(isApprovingPayload({ value: "approve" })).toBe(true);
    expect(isApprovingPayload({ value: "Approved" })).toBe(true);
    expect(isApprovingPayload("yes")).toBe(true);
  });

  test("the inbox {chosen} shape is recognized (mt#3007)", () => {
    // The exact payload a real operator approval wrote (ask 7fee3742 / ask#24).
    // Before mt#3007 this returned false, so a genuinely approved ask failed
    // verification and the bridge refused to mint the grant.
    expect(isApprovingPayload({ chosen: "approve", option: "approve" })).toBe(true);
    expect(isApprovingPayload({ chosen: "approved" })).toBe(true);
    expect(isApprovingPayload({ chosen: "Yes" })).toBe(true);
    expect(isApprovingPayload({ option: "approve" })).toBe(true);
  });

  test("a chosen DECLINE is not an approval", () => {
    // The failure this function must never make: treating the act of answering
    // an authorization ask as approving it.
    expect(isApprovingPayload({ chosen: "reject", option: "reject" })).toBe(false);
    expect(isApprovingPayload({ chosen: "deny" })).toBe(false);
    expect(isApprovingPayload({ chosen: "hold-fix-first" })).toBe(false);
  });

  test("a non-approve-shaped option value fails CLOSED", () => {
    // Deliberate: the chosen value is an option value, not necessarily the word
    // "approved". Rather than resolve it against the ask's option list, an
    // unrecognized value is refused.
    expect(isApprovingPayload({ chosen: "authorize-hook-override" })).toBe(false);
  });

  test("a free-text message is not a structured approval", () => {
    // Accepting prose would let an agent mint authorization by writing text.
    expect(isApprovingPayload({ message: "approve" })).toBe(false);
    expect(isApprovingPayload({ message: "yes, go ahead and do it" })).toBe(false);
  });

  test("everything else is NOT approval (conservative default)", () => {
    expect(isApprovingPayload(undefined)).toBe(false);
    expect(isApprovingPayload(null)).toBe(false);
    expect(isApprovingPayload({ approved: false })).toBe(false);
    expect(isApprovingPayload({ value: "deny" })).toBe(false);
    expect(isApprovingPayload({ something: "else" })).toBe(false);
    expect(isApprovingPayload("proceed with caution")).toBe(false);
  });
});

describe("evaluateAskRows", () => {
  test("approved when all criteria hold", () => {
    expect(evaluateAskRows([approvedRow()], ASK_ID).verdict).toBe("approved");
  });

  test("the recorded ask#24 row shape verifies as approved (mt#3007 regression)", () => {
    // Closed, operator-responded, {chosen: "approve"} — the exact combination
    // that was refused before mt#3007.
    const result = evaluateAskRows(
      [
        approvedRow({
          state: "closed",
          response: { responder: "operator", payload: { chosen: "approve", option: "approve" } },
        }),
      ],
      ASK_ID
    );
    expect(result.verdict).toBe("approved");
  });

  test("not found → not-approved (the fabricated-askId case)", () => {
    const result = evaluateAskRows([], ASK_ID);
    expect(result.verdict).toBe("not-approved");
    expect(result.detail).toMatch(/not found/);
  });

  test("wrong kind → not-approved", () => {
    const result = evaluateAskRows([approvedRow({ kind: "direction.decide" })], ASK_ID);
    expect(result.verdict).toBe("not-approved");
    expect(result.detail).toMatch(/kind/);
  });

  test("agent-attributed responder → not-approved (self-respond vector closed)", () => {
    const result = evaluateAskRows(
      [approvedRow({ response: { responder: "agent:project:abc", payload: { approved: true } } })],
      ASK_ID
    );
    expect(result.verdict).toBe("not-approved");
    expect(result.detail).toMatch(/responder/);
  });

  test("policy/timeout responders → not-approved", () => {
    for (const responder of ["policy", "timeout"]) {
      const result = evaluateAskRows(
        [approvedRow({ response: { responder, payload: { approved: true } } })],
        ASK_ID
      );
      expect(result.verdict).toBe("not-approved");
    }
  });

  test("non-approving response value → not-approved", () => {
    const result = evaluateAskRows(
      [approvedRow({ response: { responder: "operator", payload: { approved: false } } })],
      ASK_ID
    );
    expect(result.verdict).toBe("not-approved");
    expect(result.detail).toMatch(/not an approval/);
  });
});

describe("verifyApprovedAsk", () => {
  /** Exec fake for the by-id read: returns `row` for any `asks get` call. */
  const foundExec =
    (row: AskRow): ExecFn =>
    () => ({ exitCode: 0, stdout: JSON.stringify(row), stderr: "" });

  test("reads the ask BY ID, not by paging a list (mt#3007)", () => {
    // Regression guard for the defect this replaced: the old implementation
    // paged `tools asks list --state ... --limit 200` on the false assumption
    // that the page was newest-first, so a genuinely approved ask outside the
    // page verified as "not found".
    let invoked: string[] = [];
    const spyExec: ExecFn = (cmd) => {
      invoked = cmd;
      return { exitCode: 0, stdout: JSON.stringify(approvedRow()), stderr: "" };
    };

    expect(verifyApprovedAsk(ASK_ID, spyExec).verdict).toBe("approved");
    expect(invoked).toEqual(["minsky", "tools", "asks", "get", ASK_ID]);
    expect(invoked).not.toContain("list");
    expect(invoked).not.toContain("--state");
  });

  test("approved regardless of which state the ask is in", () => {
    expect(verifyApprovedAsk(ASK_ID, foundExec(approvedRow({ state: "closed" }))).verdict).toBe(
      "approved"
    );
    expect(verifyApprovedAsk(ASK_ID, foundExec(approvedRow({ state: "responded" }))).verdict).toBe(
      "approved"
    );
  });

  test("the recorded ask#24 payload verifies end-to-end", () => {
    const row = approvedRow({
      state: "closed",
      response: { responder: "operator", payload: { chosen: "approve", option: "approve" } },
    });
    expect(verifyApprovedAsk(ASK_ID, foundExec(row)).verdict).toBe("approved");
  });

  test("nonexistent ask → not-approved (fail closed on a fabricated id)", () => {
    const notFoundExec: ExecFn = () => ({
      exitCode: 1,
      stdout: `❌ Ask not found with id "${ASK_ID}"`,
      stderr: "",
    });
    const result = verifyApprovedAsk(ASK_ID, notFoundExec);
    expect(result.verdict).toBe("not-approved");
    expect(result.detail).toMatch(/does not exist/);
  });

  test("CLI failure → unavailable (caller defers, never allows)", () => {
    const failingExec: ExecFn = () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    expect(verifyApprovedAsk(ASK_ID, failingExec).verdict).toBe("unavailable");
  });

  test("unparseable output → unavailable", () => {
    const garbageExec: ExecFn = () => ({ exitCode: 0, stdout: "not json", stderr: "" });
    expect(verifyApprovedAsk(ASK_ID, garbageExec).verdict).toBe("unavailable");
  });

  test("a DB outage is never mistaken for a missing ask", () => {
    // "unavailable" and "not-approved" must stay distinguishable: the first
    // means retry/defer, the second means refuse.
    const outageExec: ExecFn = () => ({
      exitCode: 1,
      stdout: "",
      stderr: "connection refused",
    });
    expect(verifyApprovedAsk(ASK_ID, outageExec).verdict).toBe("unavailable");
  });
});
