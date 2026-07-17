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
  const okExec =
    (rowsByState: Record<string, AskRow[]>): ExecFn =>
    (cmd) => {
      const state = cmd[cmd.indexOf("--state") + 1] as string;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ asks: rowsByState[state] ?? [] }),
        stderr: "",
      };
    };

  test("finds the ask in the closed state too", () => {
    const result = verifyApprovedAsk(
      ASK_ID,
      okExec({ responded: [], closed: [approvedRow({ state: "closed" })] })
    );
    expect(result.verdict).toBe("approved");
  });

  test("CLI failure → unavailable (caller defers, never allows)", () => {
    const failingExec: ExecFn = () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    expect(verifyApprovedAsk(ASK_ID, failingExec).verdict).toBe("unavailable");
  });

  test("unparseable output → unavailable", () => {
    const garbageExec: ExecFn = () => ({ exitCode: 0, stdout: "not json", stderr: "" });
    expect(verifyApprovedAsk(ASK_ID, garbageExec).verdict).toBe("unavailable");
  });

  const partialExec =
    (failState: string, rowsInOther: AskRow[]): ExecFn =>
    (cmd) => {
      const state = cmd[cmd.indexOf("--state") + 1] as string;
      if (state === failState) return { exitCode: 1, stdout: "", stderr: "down" };
      return { exitCode: 0, stdout: JSON.stringify({ asks: rowsInOther }), stderr: "" };
    };

  test("one fetch fails but the ask is FOUND approved in the readable state → approved", () => {
    const result = verifyApprovedAsk(
      ASK_ID,
      partialExec("responded", [approvedRow({ state: "closed" })])
    );
    expect(result.verdict).toBe("approved");
  });

  test("one fetch fails and the ask is found NOT-approved in the readable state → not-approved (definitive)", () => {
    const result = verifyApprovedAsk(
      ASK_ID,
      partialExec("responded", [
        approvedRow({
          state: "closed",
          response: { responder: "operator", payload: { approved: false } },
        }),
      ])
    );
    expect(result.verdict).toBe("not-approved");
  });

  test("one fetch fails and the ask is not found in the readable state → unavailable", () => {
    const result = verifyApprovedAsk(ASK_ID, partialExec("responded", []));
    expect(result.verdict).toBe("unavailable");
    expect(result.detail).toMatch(/cannot distinguish/);
  });
});
