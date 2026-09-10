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
  MONITOR_RECOVERY_RESPONDER,
  buildAskCreateArguments,
  buildCoalesceKey,
  decideAskAlert,
  decideAskCancel,
  describeResponseBody,
  parseAskCancelResponse,
  parseAskCreateResponse,
  parseOpenAsksResponse,
  runAskAlert,
  runAskRecoveryClose,
  selectJsonRpcResponse,
  type ExistingAsk,
} from "./monitor-ask-alert";
import { parseSseEventData } from "../../../../src/mcp/shim/sse";

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
    state: "suspended",
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
        openAsks: [{ ...openAsk, state: "closed" }],
        service: SERVICE,
        failureClass: FAILURE_CLASS,
      })
    ).toEqual({ action: "create" });
  });

  test("matches on metadata, not on title collision", () => {
    expect(
      decideAskAlert({
        openAsks: [{ id: "other", state: "suspended", metadata: { service: SERVICE } }],
        service: SERVICE,
        failureClass: FAILURE_CLASS,
      })
    ).toEqual({ action: "create" });
  });
});

describe("decideAskAlert — open-vs-terminal state handling (PR #2888 R1)", () => {
  const withState = (state: string): ExistingAsk => ({
    id: ASK_UUID,
    state,
    metadata: { [COALESCE_KEY_FIELD]: buildCoalesceKey(SERVICE, FAILURE_CLASS) },
  });

  // The canonical AskState enum (packages/domain/src/ask/types.ts). The first
  // version of this module invented "pending"/"delivered" and omitted
  // "detected"/"responded", so coalescing would never have fired.
  test.each(["detected", "classified", "routed", "suspended", "responded"])(
    "%s is OPEN — coalesces",
    (state) => {
      expect(
        decideAskAlert({
          openAsks: [withState(state)],
          service: SERVICE,
          failureClass: FAILURE_CLASS,
        })
      ).toEqual({ action: "skip", reason: "already-open", existingAskId: ASK_UUID });
    }
  );

  test.each(["closed", "cancelled", "expired"])("%s is TERMINAL — creates a new ask", (state) => {
    expect(
      decideAskAlert({
        openAsks: [withState(state)],
        service: SERVICE,
        failureClass: FAILURE_CLASS,
      })
    ).toEqual({ action: "create" });
  });

  test("an UNRECOGNIZED state is treated as open — fails toward a duplicate, not a dropped alert", () => {
    // A state added to the enum later must not silently disable coalescing.
    expect(
      decideAskAlert({
        openAsks: [withState("some-future-state")],
        service: SERVICE,
        failureClass: FAILURE_CLASS,
      })
    ).toEqual({ action: "skip", reason: "already-open", existingAskId: ASK_UUID });
  });
});

describe("runAskAlert — the end-to-end sequence (PR #2888 R1)", () => {
  function recordingCaller(responses: Record<string, unknown>) {
    const calls: Array<{ name: string; args: object }> = [];
    const callTool = async (name: string, args: object) => {
      calls.push({ name, args });
      return responses[name];
    };
    return { calls, callTool };
  }

  test("lists, then creates, and returns the created id", async () => {
    const { calls, callTool } = recordingCaller({
      asks_list: jsonResult([]),
      asks_create: jsonResult({ id: ASK_UUID }),
    });

    const result = await runAskAlert({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      subject: "subject",
      details: "details",
    });

    expect(result).toEqual({ outcome: "created", askId: ASK_UUID });
    expect(calls.map((c) => c.name)).toEqual(["asks_list", "asks_create"]);
    // And the create carried the declared params, not the old ones.
    const createArgs = calls[1]?.args as Record<string, unknown>;
    expect(createArgs.title).toBe("subject");
    expect(createArgs.question).toBe("details");
    expect(createArgs.severity).toBe("incident");
    expect(createArgs).not.toHaveProperty("body");
  });

  test("coalesces WITHOUT calling asks_create at all", async () => {
    const { calls, callTool } = recordingCaller({
      asks_list: jsonResult([
        {
          id: ASK_UUID,
          state: "suspended",
          metadata: { [COALESCE_KEY_FIELD]: buildCoalesceKey(SERVICE, FAILURE_CLASS) },
        },
      ]),
    });

    const result = await runAskAlert({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      subject: "subject",
      details: "details",
    });

    expect(result).toEqual({ outcome: "coalesced", existingAskId: ASK_UUID });
    expect(calls.map((c) => c.name)).toEqual(["asks_list"]);
  });

  test("THROWS when the create is accepted but produces no ask", async () => {
    // The defect this whole task exists for: previously this path logged
    // "sent successfully". A thrown error cannot be mistaken for success.
    const { callTool } = recordingCaller({
      asks_list: jsonResult([]),
      asks_create: { error: { code: -32602, message: "Tool not found" } },
    });

    await expect(
      runAskAlert({
        callTool,
        service: SERVICE,
        failureClass: FAILURE_CLASS,
        subject: "subject",
        details: "details",
      })
    ).rejects.toThrow(/did not create an ask/);
  });

  test("an unreadable listing still creates — fails open rather than dropping the alert", async () => {
    const { calls, callTool } = recordingCaller({
      asks_list: { error: { message: "listing blew up" } },
      asks_create: jsonResult({ id: ASK_UUID }),
    });

    const result = await runAskAlert({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      subject: "subject",
      details: "details",
    });

    expect(result).toEqual({ outcome: "created", askId: ASK_UUID });
    expect(calls.map((c) => c.name)).toEqual(["asks_list", "asks_create"]);
  });
});

describe("parseOpenAsksResponse", () => {
  const row = {
    id: ASK_UUID,
    state: "suspended",
    metadata: { [COALESCE_KEY_FIELD]: buildCoalesceKey(SERVICE, FAILURE_CLASS) },
  };

  test("reads a bare array of asks", () => {
    expect(parseOpenAsksResponse(jsonResult([row]))).toEqual([row]);
  });

  test("reads an { asks: [...] } envelope", () => {
    expect(parseOpenAsksResponse(jsonResult({ asks: [row] }))).toEqual([row]);
  });

  test("drops rows without a string id rather than inventing one", () => {
    expect(parseOpenAsksResponse(jsonResult([{ state: "suspended" }, row]))).toEqual([row]);
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

// ---------------------------------------------------------------------------
// mt#4012 — reading an SSE-framed response body
// ---------------------------------------------------------------------------

/**
 * Frame a JSON-RPC message the way the MCP Streamable-HTTP transport does.
 * Mirrors a real captured body: `event: message` then one `data:` line.
 */
function sseFrame(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/** The content type the transport does NOT send for a tool call — the contrast case. */
const JSON_CONTENT_TYPE = "application/json";

/** The disposition that makes a re-run safe (AT4). */
const ALREADY_TERMINAL = "already-terminal";

describe("selectJsonRpcResponse (mt#4012)", () => {
  test("REGRESSION: the exact production body shape parses instead of throwing", () => {
    // This is the defect. `await res.json()` on this body threw
    // `SyntaxError: Failed to parse JSON` on every call the channel ever made,
    // across at least the 2026-09-09/10 site outage and the 2026-08-19 reviewer
    // outage. Verified byte-exact against a live `minsky mcp start --http`.
    const body =
      "event: message\n" +
      `data: {"result":{"content":[{"type":"text","text":"{\\"id\\":\\"${ASK_UUID}\\"}"}]},"jsonrpc":"2.0","id":2}\n\n`;

    // The old read, kept as an executable statement of what was broken.
    expect(() => JSON.parse(body)).toThrow();

    const message = selectJsonRpcResponse(parseSseEventData(body), 2);
    expect(parseAskCreateResponse(message)).toEqual({ ok: true, askId: ASK_UUID });
  });

  test("selects the frame whose JSON-RPC id matches the request", () => {
    const buffers = parseSseEventData(
      sseFrame({ jsonrpc: "2.0", method: "notifications/progress", params: {} }) +
        sseFrame({ jsonrpc: "2.0", id: 7, result: { content: [] } }) +
        sseFrame({ jsonrpc: "2.0", id: 8, result: { content: [] } })
    );
    expect(selectJsonRpcResponse(buffers, 8)).toMatchObject({ id: 8 });
  });

  test("a progress notification ahead of the result does not win", () => {
    // The reason this matches on id rather than taking the first frame.
    const buffers = parseSseEventData(
      sseFrame({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) +
        sseFrame({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "{}" }] } })
    );
    expect(selectJsonRpcResponse(buffers, 3)).toMatchObject({ id: 3 });
  });

  test("falls back to the first parseable object when no id matches", () => {
    const buffers = parseSseEventData(sseFrame({ jsonrpc: "2.0", id: 99, result: {} }));
    expect(selectJsonRpcResponse(buffers, 2)).toMatchObject({ id: 99 });
  });

  test("a non-JSON frame is skipped rather than failing the whole read", () => {
    const buffers = parseSseEventData(
      `event: message\ndata: not-json\n\n${sseFrame({ jsonrpc: "2.0", id: 4, result: {} })}`
    );
    expect(selectJsonRpcResponse(buffers, 4)).toMatchObject({ id: 4 });
  });

  test("returns null when nothing parsed, which the outcome parsers read as FAILURE", () => {
    expect(selectJsonRpcResponse([], 2)).toBeNull();
    // The fallback can never manufacture a success.
    expect(parseAskCreateResponse(selectJsonRpcResponse([], 2)).ok).toBe(false);
  });
});

describe("describeResponseBody (mt#4012)", () => {
  test("identifies SSE frames — the shape that was failing in production", () => {
    expect(describeResponseBody("text/event-stream", sseFrame({ id: 2 }))).toContain(
      "shape=sse-frames"
    );
  });

  test("distinguishes the other candidate shapes the diagnosis had to rule out", () => {
    expect(describeResponseBody(JSON_CONTENT_TYPE, '{"a":1}')).toContain("shape=json-object");
    expect(describeResponseBody("text/html", "<html><body>401</body></html>")).toContain("markup");
    expect(describeResponseBody(null, "   ")).toContain("shape=empty");
    expect(describeResponseBody(null, "")).toContain('content-type="(absent)"');
  });

  test("reports byte length, so an empty body is distinguishable from a missing read", () => {
    expect(describeResponseBody(JSON_CONTENT_TYPE, '{"a":1}')).toContain("7 bytes");
  });

  test("emits NO body content — this string lands in a public Actions log", () => {
    const secretish = JSON.stringify({ token: "ghp_examplevalue", title: "prod outage detail" });
    const described = describeResponseBody(JSON_CONTENT_TYPE, secretish);
    expect(described).not.toContain("ghp_examplevalue");
    expect(described).not.toContain("prod outage detail");
    expect(described).not.toContain("token");
  });
});

// ---------------------------------------------------------------------------
// mt#4012 — retiring an ask when its class recovers
// ---------------------------------------------------------------------------

const COALESCED_ASK: ExistingAsk = {
  id: ASK_UUID,
  state: "suspended",
  metadata: { [COALESCE_KEY_FIELD]: buildCoalesceKey(SERVICE, FAILURE_CLASS) },
};

describe("decideAskCancel (mt#4012)", () => {
  test("cancels the ask carrying this incident's coalesce key", () => {
    expect(
      decideAskCancel({ openAsks: [COALESCED_ASK], service: SERVICE, failureClass: FAILURE_CLASS })
    ).toEqual({ action: "cancel", askId: ASK_UUID });
  });

  test("matches the SAME key decideAskAlert coalesces on, so the two agree", () => {
    // Whatever ask the alert path would have coalesced onto is the one the
    // recovery path retires — asserted against the alert decision itself.
    const alert = decideAskAlert({
      openAsks: [COALESCED_ASK],
      service: SERVICE,
      failureClass: FAILURE_CLASS,
    });
    const cancel = decideAskCancel({
      openAsks: [COALESCED_ASK],
      service: SERVICE,
      failureClass: FAILURE_CLASS,
    });
    expect(alert).toEqual({ action: "skip", reason: "already-open", existingAskId: ASK_UUID });
    expect(cancel).toEqual({ action: "cancel", askId: ASK_UUID });
  });

  test("a different service or class is NOT retired", () => {
    expect(
      decideAskCancel({
        openAsks: [COALESCED_ASK],
        service: "minsky-mcp",
        failureClass: FAILURE_CLASS,
      })
    ).toEqual({ action: "none", reason: "no-open-ask" });
    expect(
      decideAskCancel({ openAsks: [COALESCED_ASK], service: SERVICE, failureClass: "health-down" })
    ).toEqual({ action: "none", reason: "no-open-ask" });
  });

  test("an already-terminal ask is not retired again (AT4)", () => {
    for (const state of ["closed", "cancelled", "expired"]) {
      expect(
        decideAskCancel({
          openAsks: [{ ...COALESCED_ASK, state }],
          service: SERVICE,
          failureClass: FAILURE_CLASS,
        })
      ).toEqual({ action: "none", reason: "no-open-ask" });
    }
  });

  test("no open asks at all is a no-op, not an error", () => {
    expect(
      decideAskCancel({ openAsks: [], service: SERVICE, failureClass: FAILURE_CLASS })
    ).toEqual({
      action: "none",
      reason: "no-open-ask",
    });
  });
});

describe("parseAskCancelResponse (mt#4012)", () => {
  test.each(["cancelled", "closed", ALREADY_TERMINAL])(
    "%s is a terminal disposition — SUCCESS",
    (outcome) => {
      expect(parseAskCancelResponse(jsonResult({ askId: ASK_UUID, outcome }))).toEqual({
        ok: true,
        askId: ASK_UUID,
        outcome,
      });
    }
  );

  test.each(["not-found", "skipped"])(
    "%s leaves the ask unretired — FAILURE, not a benign no-op",
    (outcome) => {
      const result = parseAskCancelResponse(jsonResult({ askId: ASK_UUID, outcome }));
      expect(result.ok).toBe(false);
    }
  );

  test("a JSON-RPC error is a FAILURE even though HTTP was 200", () => {
    const result = parseAskCancelResponse({ error: { message: "no such tool", code: -32601 } });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("-32601") });
  });

  test("isError is a FAILURE", () => {
    expect(
      parseAskCancelResponse({
        result: { isError: true, content: [{ type: "text", text: "boom" }] },
      }).ok
    ).toBe(false);
  });

  test("a success-shaped result with no outcome is a FAILURE", () => {
    // Same rule as the create path: only a real disposition proves anything.
    expect(parseAskCancelResponse(jsonResult({ askId: ASK_UUID })).ok).toBe(false);
    expect(parseAskCancelResponse(jsonResult({})).ok).toBe(false);
  });

  test("a non-object body is a FAILURE", () => {
    expect(parseAskCancelResponse(null).ok).toBe(false);
    expect(parseAskCancelResponse("cancelled").ok).toBe(false);
  });
});

describe("runAskRecoveryClose (mt#4012)", () => {
  function caller(responses: Record<string, unknown>) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = async (name: string, args: object) => {
      calls.push({ name, args: args as Record<string, unknown> });
      return responses[name];
    };
    return { calls, callTool };
  }

  test("AT2: an open coalesced ask is listed, cancelled, and verified", async () => {
    const { calls, callTool } = caller({
      asks_list: jsonResult([COALESCED_ASK]),
      asks_cancel: jsonResult({ askId: ASK_UUID, outcome: "cancelled" }),
    });

    const result = await runAskRecoveryClose({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      reason: "recovered",
    });

    expect(result).toEqual({ outcome: "cancelled", askId: ASK_UUID, disposition: "cancelled" });
    expect(calls.map((c) => c.name)).toEqual(["asks_list", "asks_cancel"]);
    expect(calls[1]?.args).toMatchObject({ id: ASK_UUID, reason: "recovered" });
  });

  test("records a SYSTEM responder, never the operator (SC3)", async () => {
    // `asks.cancel` REJECTS a literal `operator` responder, because cancelling
    // is not answering — recording the principal would misreport an automated
    // withdrawal as a decision they made.
    const { calls, callTool } = caller({
      asks_list: jsonResult([COALESCED_ASK]),
      asks_cancel: jsonResult({ askId: ASK_UUID, outcome: "cancelled" }),
    });
    await runAskRecoveryClose({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      reason: "recovered",
    });
    expect(calls[1]?.args.responder).toBe(MONITOR_RECOVERY_RESPONDER);
    expect(MONITOR_RECOVERY_RESPONDER).toStartWith("system:");
    expect(MONITOR_RECOVERY_RESPONDER).not.toBe("operator");
  });

  test("no open ask: does NOT call asks_cancel at all", async () => {
    const { calls, callTool } = caller({ asks_list: jsonResult([]) });
    const result = await runAskRecoveryClose({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      reason: "recovered",
    });
    expect(result).toEqual({ outcome: "none", reason: "no-open-ask" });
    expect(calls.map((c) => c.name)).toEqual(["asks_list"]);
  });

  test("AT4: a re-run after the close neither reopens nor duplicates", async () => {
    // Second tick sees the ask already terminal, so it short-circuits at the
    // decision and issues no cancel.
    const { calls, callTool } = caller({
      asks_list: jsonResult([{ ...COALESCED_ASK, state: "cancelled" }]),
    });
    const result = await runAskRecoveryClose({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      reason: "recovered",
    });
    expect(result).toEqual({ outcome: "none", reason: "no-open-ask" });
    expect(calls.map((c) => c.name)).toEqual(["asks_list"]);
  });

  test("AT4: an already-terminal disposition from the tool is still a success", async () => {
    // The race where two ticks overlap: we decided to cancel, someone else got
    // there first. Idempotent by `asks.cancel`'s own contract.
    const { callTool } = caller({
      asks_list: jsonResult([COALESCED_ASK]),
      asks_cancel: jsonResult({ askId: ASK_UUID, outcome: ALREADY_TERMINAL }),
    });
    const result = await runAskRecoveryClose({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      reason: "recovered",
    });
    expect(result).toMatchObject({ outcome: "cancelled", disposition: ALREADY_TERMINAL });
  });

  test("a cancel that did not retire the ask THROWS rather than reading as success", async () => {
    const { callTool } = caller({
      asks_list: jsonResult([COALESCED_ASK]),
      asks_cancel: jsonResult({ askId: ASK_UUID, outcome: "not-found" }),
    });
    await expect(
      runAskRecoveryClose({
        callTool,
        service: SERVICE,
        failureClass: FAILURE_CLASS,
        reason: "recovered",
      })
    ).rejects.toThrow(/did not retire ask/);
  });

  test("an unreadable asks_list retires NOTHING (fails safe)", async () => {
    // parseOpenAsksResponse returns [] on any unreadable shape. On the alert
    // side that duplicates an ask; here it simply retires nothing, which is the
    // safe direction — a mis-parse must never close a live incident's ask.
    const { calls, callTool } = caller({ asks_list: { error: { message: "boom" } } });
    const result = await runAskRecoveryClose({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      reason: "recovered",
    });
    expect(result).toEqual({ outcome: "none", reason: "no-open-ask" });
    expect(calls.map((c) => c.name)).toEqual(["asks_list"]);
  });

  test("lists the monitor's own ask kind", async () => {
    const { calls, callTool } = caller({ asks_list: jsonResult([]) });
    await runAskRecoveryClose({
      callTool,
      service: SERVICE,
      failureClass: FAILURE_CLASS,
      reason: "recovered",
    });
    expect(calls[0]?.args).toEqual({ kind: MONITOR_ALERT_ASK_KIND });
  });
});
