/**
 * Tests for mt#2782's monitor ask-alert decisions.
 *
 * The centre of gravity is `parseAskCreateResponse`: the shipped defect was an
 * actuator that reported success without checking its outcome, so most of these
 * assert that a call which did NOT create an ask is reported as a failure.
 */

import { describe, expect, test } from "bun:test";

import {
  COALESCE_KEY_FIELD,
  MONITOR_ALERT_ASK_KIND,
  buildAskCreateArguments,
  buildCoalesceKey,
  decideAskAlert,
  parseAskCreateResponse,
  parseOpenAsksResponse,
  type ExistingAsk,
} from "./monitor-ask-alert";

const SERVICE = "minsky-ops";
const FAILURE_CLASS = "digest-lag";
const ASK_UUID = "74b4baa6-6d09-4947-ae27-3daac7dfc697";

function jsonResult(payload: unknown) {
  return { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } };
}

describe("buildAskCreateArguments", () => {
  const args = buildAskCreateArguments({
    service: SERVICE,
    failureClass: FAILURE_CLASS,
    subject: "minsky-ops digest lag exceeded threshold",
    details: "digest is 42 minutes behind",
  });

  test("sends only params asks.create declares", () => {
    // The original call sent subject/body/priority, none of which are declared —
    // rejected by the mt#2778 boundary check even once the tool name is fixed.
    expect(Object.keys(args).sort()).toEqual([
      "forceImmediate",
      "kind",
      "metadata",
      "question",
      "severity",
      "title",
    ]);
    expect(args).not.toHaveProperty("subject");
    expect(args).not.toHaveProperty("body");
    expect(args).not.toHaveProperty("priority");
  });

  test("maps subject -> title and details -> question", () => {
    expect(args.title).toBe("minsky-ops digest lag exceeded threshold");
    expect(args.question).toBe("digest is 42 minutes behind");
    expect(args.kind).toBe(MONITOR_ALERT_ASK_KIND);
  });

  test("carries both severity and forceImmediate — they are independent settings", () => {
    // severity decides whether the principal is NOTIFIED; forceImmediate decides
    // whether the ask waits for the next service window. A notification pointing
    // at an ask that has not landed yet is worse than either alone.
    expect(args.severity).toBe("incident");
    expect(args.forceImmediate).toBe(true);
  });

  test("carries the coalesce key in metadata", () => {
    expect(args.metadata[COALESCE_KEY_FIELD]).toBe(buildCoalesceKey(SERVICE, FAILURE_CLASS));
    expect(args.metadata.service).toBe(SERVICE);
    expect(args.metadata.failureClass).toBe(FAILURE_CLASS);
  });
});

describe("decideAskAlert", () => {
  const openAsk: ExistingAsk = {
    id: ASK_UUID,
    status: "suspended",
    metadata: { [COALESCE_KEY_FIELD]: buildCoalesceKey(SERVICE, FAILURE_CLASS) },
  };

  test("creates when nothing is open for this incident", () => {
    expect(decideAskAlert({ openAsks: [], service: SERVICE, failureClass: FAILURE_CLASS })).toEqual(
      {
        action: "create",
      }
    );
  });

  test("coalesces onto an ask already open for the same incident", () => {
    expect(
      decideAskAlert({ openAsks: [openAsk], service: SERVICE, failureClass: FAILURE_CLASS })
    ).toEqual({ action: "skip", reason: "already-open", existingAskId: ASK_UUID });
  });

  test("a DIFFERENT failure class on the same service still creates", () => {
    expect(
      decideAskAlert({ openAsks: [openAsk], service: SERVICE, failureClass: "check-failed" })
    ).toEqual({ action: "create" });
  });

  test("the same class on a DIFFERENT service still creates", () => {
    expect(
      decideAskAlert({ openAsks: [openAsk], service: "minsky-mcp", failureClass: FAILURE_CLASS })
    ).toEqual({ action: "create" });
  });

  test("a CLOSED ask for this incident does not suppress a new one", () => {
    // The incident recurring after being resolved must alert again.
    expect(
      decideAskAlert({
        openAsks: [{ ...openAsk, status: "closed" }],
        service: SERVICE,
        failureClass: FAILURE_CLASS,
      })
    ).toEqual({ action: "create" });
  });

  test("matches on metadata, not on title collision", () => {
    expect(
      decideAskAlert({
        openAsks: [{ id: "other", status: "suspended", metadata: { service: SERVICE } }],
        service: SERVICE,
        failureClass: FAILURE_CLASS,
      })
    ).toEqual({ action: "create" });
  });
});

describe("parseOpenAsksResponse", () => {
  const row = {
    id: ASK_UUID,
    status: "suspended",
    metadata: { [COALESCE_KEY_FIELD]: buildCoalesceKey(SERVICE, FAILURE_CLASS) },
  };

  test("reads a bare array of asks", () => {
    expect(parseOpenAsksResponse(jsonResult([row]))).toEqual([row]);
  });

  test("reads an { asks: [...] } envelope", () => {
    expect(parseOpenAsksResponse(jsonResult({ asks: [row] }))).toEqual([row]);
  });

  test("drops rows without a string id rather than inventing one", () => {
    expect(parseOpenAsksResponse(jsonResult([{ status: "suspended" }, row]))).toEqual([row]);
  });

  test("an unreadable listing FAILS OPEN — empty, so the alert still fires", () => {
    // The asymmetry is deliberate and load-bearing. Reporting a phantom open ask
    // would SUPPRESS a production alert; reporting none duplicates an ask, which
    // is noisy and recoverable. Fail toward the noisy side.
    expect(parseOpenAsksResponse({ error: { message: "boom" } })).toEqual([]);
    expect(parseOpenAsksResponse({ result: { isError: true, content: [] } })).toEqual([]);
    expect(
      parseOpenAsksResponse({ result: { content: [{ type: "text", text: "not json" }] } })
    ).toEqual([]);
    expect(parseOpenAsksResponse(null)).toEqual([]);
  });

  test("an empty listing coalesces to 'create'", () => {
    const openAsks = parseOpenAsksResponse(jsonResult([]));
    expect(decideAskAlert({ openAsks, service: SERVICE, failureClass: FAILURE_CLASS })).toEqual({
      action: "create",
    });
  });

  test("round-trips into a skip decision", () => {
    const openAsks = parseOpenAsksResponse(jsonResult({ asks: [row] }));
    expect(decideAskAlert({ openAsks, service: SERVICE, failureClass: FAILURE_CLASS })).toEqual({
      action: "skip",
      reason: "already-open",
      existingAskId: ASK_UUID,
    });
  });
});

describe("parseAskCreateResponse — success is the returned id, not the absence of a throw", () => {
  test("a JSON-RPC error in an HTTP 200 body is a FAILURE", () => {
    // This is the shipped defect: the old code checked callRes.ok only, so this
    // exact shape logged "sent successfully".
    const outcome = parseAskCreateResponse({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602, message: "Tool mcp__minsky__asks_create not found" },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("not found");
  });

  test("a tool-level isError result is a FAILURE", () => {
    const outcome = parseAskCreateResponse({
      result: { isError: true, content: [{ type: "text", text: "undeclared param: priority" }] },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("undeclared param");
  });

  test("a success-shaped result with NO ask id is a FAILURE", () => {
    // The subtlest case, and the reason "it didn't throw" is not evidence: the
    // call was accepted and nothing was created.
    const outcome = parseAskCreateResponse(jsonResult({ acknowledged: true }));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain("no ask id");
  });

  test("neither result nor error is a FAILURE", () => {
    expect(parseAskCreateResponse({ jsonrpc: "2.0", id: 2 }).ok).toBe(false);
  });

  test("a non-object body is a FAILURE", () => {
    expect(parseAskCreateResponse(null).ok).toBe(false);
    expect(parseAskCreateResponse("ok").ok).toBe(false);
  });

  test("a created ask's uuid id is a SUCCESS", () => {
    const outcome = parseAskCreateResponse(jsonResult({ id: ASK_UUID, shortId: "ask#8014" }));
    expect(outcome).toEqual({ ok: true, askId: ASK_UUID });
  });

  test("a shortId alone is a SUCCESS", () => {
    expect(parseAskCreateResponse(jsonResult({ shortId: "ask#8014" }))).toEqual({
      ok: true,
      askId: "ask#8014",
    });
  });

  test("an id embedded in prose is a SUCCESS", () => {
    const outcome = parseAskCreateResponse({
      result: { content: [{ type: "text", text: `Created ask#8014 for the alert.` }] },
    });
    expect(outcome).toEqual({ ok: true, askId: "ask#8014" });
  });
});
