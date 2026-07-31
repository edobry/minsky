import { describe, expect, test, mock } from "bun:test";
import {
  emitReviewPostedEvent,
  type ReviewPostedEvent,
  type ReviewSubmitEvent,
} from "./review-events";
import type { ReviewerConfig } from "./config";
import type { CallMcpResult, McpClientConfig, CallMcpOptions } from "./mcp-client";

// mt#2725: emitReviewPostedEvent is the pr.review_posted emit for the reviewer's
// two success paths. Tested in isolation via the injectable callMcp seam (same
// convention as callReviewerWithRetry's callReviewerFn default), so the
// event->state mapping, payload shape, config guard, and error-swallowing are
// all covered without driving the full runReview GitHub/model stack (that
// full-path invocation guard is mt#1263 / mt#2731 territory).

/** Structural match of the real `callMcp` signature (all type-only imports). */
type CallMcpFn = (
  toolName: string,
  args: Record<string, unknown>,
  config: McpClientConfig,
  options?: CallMcpOptions
) => Promise<CallMcpResult>;

const MCP_URL = "https://mcp.example";
const MCP_TOKEN = "tok";
const REVIEWER_LOGIN = "minsky-reviewer[bot]";
const TASK_ID = "mt#2725";

const CONFIGURED = { mcpUrl: MCP_URL, mcpToken: MCP_TOKEN } as unknown as ReviewerConfig;

const OK_RESULT: CallMcpResult = {
  ok: true,
  contentText: '{"success":true}',
  contentJson: null,
  rawResult: undefined,
};

function okCallMcp() {
  const impl: CallMcpFn = async () => OK_RESULT;
  return mock(impl);
}

const baseEvent: ReviewPostedEvent = {
  owner: "edobry",
  repo: "minsky",
  prNumber: 1234,
  reviewerLogin: REVIEWER_LOGIN,
  event: "APPROVE",
};

describe("emitReviewPostedEvent — event -> state mapping (mt#2725)", () => {
  const cases: Array<[ReviewSubmitEvent, string]> = [
    ["APPROVE", "APPROVED"],
    ["REQUEST_CHANGES", "CHANGES_REQUESTED"],
    ["COMMENT", "COMMENTED"],
  ];

  for (const [event, expectedState] of cases) {
    test(`${event} -> state ${expectedState}`, async () => {
      const callMcpFn = okCallMcp();
      await emitReviewPostedEvent(CONFIGURED, { ...baseEvent, event }, callMcpFn);

      expect(callMcpFn).toHaveBeenCalledTimes(1);
      const call = callMcpFn.mock.calls[0];
      if (!call) throw new Error("expected callMcp to be called");
      const [toolName, args, cfg] = call;
      expect(toolName).toBe("events_emit");
      expect(args.eventType).toBe("pr.review_posted");
      const payload = args.payload as Record<string, unknown>;
      expect(payload.state).toBe(expectedState);
      expect(cfg).toEqual({ mcpUrl: MCP_URL, mcpToken: MCP_TOKEN });
    });
  }
});

describe("emitReviewPostedEvent — payload shape (mt#2725)", () => {
  test("carries the documented { prUrl, prNumber, reviewer, state } fields + actor", async () => {
    const callMcpFn = okCallMcp();
    await emitReviewPostedEvent(CONFIGURED, { ...baseEvent, event: "REQUEST_CHANGES" }, callMcpFn);

    const call = callMcpFn.mock.calls[0];
    if (!call) throw new Error("expected callMcp to be called");
    const [, args] = call;
    const payload = args.payload as Record<string, unknown>;
    expect(payload.prUrl).toBe("https://github.com/edobry/minsky/pull/1234");
    expect(payload.prNumber).toBe(1234);
    expect(payload.reviewer).toBe(REVIEWER_LOGIN);
    expect(payload.state).toBe("CHANGES_REQUESTED");
    expect(args.actor).toBe(REVIEWER_LOGIN);
  });

  test("taskId present -> payload.taskId AND relatedTaskId set", async () => {
    const callMcpFn = okCallMcp();
    await emitReviewPostedEvent(CONFIGURED, { ...baseEvent, taskId: TASK_ID }, callMcpFn);

    const call = callMcpFn.mock.calls[0];
    if (!call) throw new Error("expected callMcp to be called");
    const [, args] = call;
    expect((args.payload as Record<string, unknown>).taskId).toBe(TASK_ID);
    expect(args.relatedTaskId).toBe(TASK_ID);
  });

  test("taskId absent -> neither payload.taskId nor relatedTaskId present", async () => {
    const callMcpFn = okCallMcp();
    await emitReviewPostedEvent(CONFIGURED, baseEvent, callMcpFn);

    const call = callMcpFn.mock.calls[0];
    if (!call) throw new Error("expected callMcp to be called");
    const [, args] = call;
    expect("taskId" in (args.payload as Record<string, unknown>)).toBe(false);
    expect("relatedTaskId" in args).toBe(false);
  });
});

describe("emitReviewPostedEvent — bounded timeout (mt#2725 R2)", () => {
  test("passes a timeout well below callMcp's 15s default (review-path tail-latency guard)", async () => {
    const callMcpFn = okCallMcp();
    await emitReviewPostedEvent(CONFIGURED, baseEvent, callMcpFn);
    const call = callMcpFn.mock.calls[0];
    if (!call) throw new Error("expected callMcp to be called");
    const options = call[3];
    expect(options?.timeoutMs).toBe(5_000);
  });
});

describe("emitReviewPostedEvent — best-effort guards (mt#2725)", () => {
  test("skips the emit entirely when MCP is unconfigured", async () => {
    const callMcpFn = okCallMcp();
    const unconfigured = { mcpUrl: undefined, mcpToken: undefined } as unknown as ReviewerConfig;
    await emitReviewPostedEvent(unconfigured, baseEvent, callMcpFn);
    expect(callMcpFn).toHaveBeenCalledTimes(0);
  });

  test("does not throw when callMcp returns a failure result", async () => {
    const failing: CallMcpFn = async () => ({
      ok: false,
      reason: "http-error",
      httpStatus: 500,
      message: "boom",
    });
    const failingMock = mock(failing);
    // Resolves (no throw) despite the failure result.
    await emitReviewPostedEvent(CONFIGURED, baseEvent, failingMock);
    expect(failingMock).toHaveBeenCalledTimes(1);
  });

  test("does not throw when callMcp itself throws", async () => {
    const thrower: CallMcpFn = async () => {
      throw new Error("network down");
    };
    const throwerMock = mock(thrower);
    // Swallowed — a review must never fail on an event-emit error.
    await emitReviewPostedEvent(CONFIGURED, baseEvent, throwerMock);
    expect(throwerMock).toHaveBeenCalledTimes(1);
  });
});
