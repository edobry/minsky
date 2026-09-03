import { describe, expect, test } from "bun:test";
import {
  ACP_PERMISSION_REQUEST_ASK_KIND,
  ACP_PERMISSION_REQUEST_METADATA_KEY,
  buildAcpPermissionRequestAsk,
  classifyAcpPermissionResponse,
  isPolicyResolved,
  type AcpPermissionRequestPayload,
} from "./acp-permission-request";
import type { Ask } from "./types";

const OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

describe("buildAcpPermissionRequestAsk", () => {
  test("uses the authorization.approve kind", () => {
    const draft = buildAcpPermissionRequestAsk({
      harnessKind: "codex",
      toolCallId: "call-1",
      toolTitle: "Run `rm -rf /tmp/x`",
      options: OPTIONS,
    });
    expect(draft.kind).toBe(ACP_PERMISSION_REQUEST_ASK_KIND);
    expect(draft.kind).toBe("authorization.approve");
  });

  test("maps each ACP option to an AskOption with value = optionId", () => {
    const draft = buildAcpPermissionRequestAsk({
      harnessKind: "codex",
      toolCallId: "call-1",
      toolTitle: "Run a command",
      options: OPTIONS,
    });
    expect(draft.options).toEqual([
      { label: "Allow once", value: "allow-once", description: "allow_once" },
      { label: "Reject", value: "reject-once", description: "reject_once" },
    ]);
  });

  test("carries no parentTaskId when the drive is unbound", () => {
    const draft = buildAcpPermissionRequestAsk({
      harnessKind: "codex",
      toolCallId: "call-1",
      toolTitle: "Run a command",
      options: OPTIONS,
    });
    expect(draft).not.toHaveProperty("parentTaskId");
  });

  test("parents to the drive's task when bound", () => {
    const draft = buildAcpPermissionRequestAsk({
      harnessKind: "codex",
      toolCallId: "call-1",
      toolTitle: "Run a command",
      options: OPTIONS,
      parentTaskId: "mt#4936",
    });
    expect(draft.parentTaskId).toBe("mt#4936");
  });

  test("stashes ACP context in metadata, never a decision", () => {
    const draft = buildAcpPermissionRequestAsk({
      harnessKind: "codex",
      toolCallId: "call-7",
      toolTitle: "Run a command",
      options: OPTIONS,
    });
    const payload = draft.metadata[
      ACP_PERMISSION_REQUEST_METADATA_KEY
    ] as AcpPermissionRequestPayload;
    expect(payload).toEqual({
      harnessKind: "codex",
      toolCallId: "call-7",
      toolTitle: "Run a command",
    });
  });
});

function makeAsk(overrides: Partial<Ask>): Pick<Ask, "state" | "response" | "routingTarget"> {
  return {
    state: "suspended",
    response: undefined,
    routingTarget: "operator",
    ...overrides,
  } as Pick<Ask, "state" | "response" | "routingTarget">;
}

describe("classifyAcpPermissionResponse", () => {
  test("suspended/routed/detected/classified all read as pending", () => {
    for (const state of ["detected", "classified", "routed", "suspended"] as const) {
      expect(classifyAcpPermissionResponse(makeAsk({ state }))).toEqual({ status: "pending" });
    }
  });

  test("cancelled and expired both read as cancelled", () => {
    expect(classifyAcpPermissionResponse(makeAsk({ state: "cancelled" }))).toEqual({
      status: "cancelled",
    });
    expect(classifyAcpPermissionResponse(makeAsk({ state: "expired" }))).toEqual({
      status: "cancelled",
    });
  });

  test("a responded ask with a recognized option value reads as selected", () => {
    const ask = makeAsk({
      state: "responded",
      response: { responder: "operator", payload: { value: "allow-once" } },
    });
    expect(classifyAcpPermissionResponse(ask)).toEqual({
      status: "selected",
      optionId: "allow-once",
    });
  });

  test("closed behaves the same as responded", () => {
    const ask = makeAsk({
      state: "closed",
      response: { responder: "operator", payload: { value: "reject-once" } },
    });
    expect(classifyAcpPermissionResponse(ask)).toEqual({
      status: "selected",
      optionId: "reject-once",
    });
  });

  test("a policy close is NEVER read as selected, even carrying a payload", () => {
    const ask = makeAsk({
      state: "closed",
      routingTarget: "policy",
      response: { responder: "policy", payload: { value: "allow-once" } },
    });
    expect(classifyAcpPermissionResponse(ask)).toEqual({ status: "policy-closed" });
    expect(isPolicyResolved(ask)).toBe(true);
  });

  test("a responder-level policy close is also caught", () => {
    const ask = makeAsk({
      state: "closed",
      routingTarget: "operator",
      response: { responder: "policy", payload: {} },
    });
    expect(classifyAcpPermissionResponse(ask)).toEqual({ status: "policy-closed" });
  });

  test("a responded ask with no recognizable option value fails closed to cancelled", () => {
    const ask = makeAsk({
      state: "responded",
      response: { responder: "operator", payload: { reason: "not now" } },
    });
    expect(classifyAcpPermissionResponse(ask)).toEqual({ status: "cancelled" });
  });
});
