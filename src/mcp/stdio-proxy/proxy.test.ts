/**
 * Stdio respawn proxy — tests for mt#2011's ping-based readiness probe and
 * `notifications/tools/list_changed` emission.
 *
 * Coverage:
 *   - Pure helpers in `./tools.ts`: buildReadyProbeRequest,
 *     isReadyProbeResponse, buildToolsListChangedNotification.
 *   - Outbound transform: probe-response swallow + notification emission to
 *     process.stdout, against a controlled `pendingProbe` state on the proxy
 *     instance.
 *
 * The full subprocess loop (real `spawn`, real stdio pipes, real Claude Code
 * client) is out of scope here — it is exercised manually per acceptance
 * test 3 in the task spec (add a tool, build, __proxy_restart_server, see
 * the new tool in ToolSearch).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Writable } from "stream";
import { AGENT_ID_META_KEY } from "@minsky/domain/agent-identity/layer2";
import { MinskyStdioProxy } from "./proxy";
import {
  PROXY_READY_PROBE_ID_PREFIX,
  PROXY_RESTART_NUDGE_TEXT,
  TOOLS_LIST_CHANGED_NOTIFICATION_METHOD,
  buildReadyProbeRequest,
  buildToolsListChangedNotification,
  isReadyProbeResponse,
  toolsListCount,
} from "./tools";

/**
 * A notification method used by more than one test as a stand-in for "an
 * ordinary non-tools/list frame". Named rather than repeated per
 * `custom/no-magic-string-duplication`.
 */
const NOTIFICATIONS_INITIALIZED = "notifications/initialized";

describe("memory-breach restart is not a crash (mt#4112)", () => {
  /**
   * A child that answers the readiness probe immediately, so each spawn costs
   * milliseconds instead of the 2s probe timeout, and stays alive otherwise.
   */
  const RESPONDER = [
    "-e",
    'process.stdin.on("data",(d)=>{for(const l of String(d).split("\\n")){' +
      "if(!l.trim())continue;try{const m=JSON.parse(l);if(m.id!==undefined)" +
      'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{}})+"\\n")}' +
      "catch{}}});process.stdin.resume()",
  ];

  test("the memory restart replaces the child without incrementing the crash counter", async () => {
    const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: RESPONDER });
    // Drive spawn/restart directly rather than through `start()`, which would
    // also install real signal handlers on the test process.
    const internals = proxy as unknown as {
      spawnChild: () => Promise<void>;
      restartChildForMemoryBreach: (breach: {
        residentBytes: number;
        ceilingBytes: number;
      }) => Promise<void>;
    };

    try {
      await internals.spawnChild();
      const firstChild = proxy.currentChild;
      expect(firstChild).not.toBeNull();
      // Positive control for the assertion below: while the child is under
      // ordinary supervision its close handler IS attached, so a real exit
      // would reach `onChildClose` and be counted.
      expect(firstChild?.listenerCount("close")).toBe(1);
      expect(proxy.recentFailureCount).toBe(0);

      await internals.restartChildForMemoryBreach({
        residentBytes: 3000 * 1024 * 1024,
        ceilingBytes: 2048 * 1024 * 1024,
      });

      // The mechanism: the handler is gone, so `onChildClose` — the only
      // writer of the crash counter — never ran for this exit.
      expect(firstChild?.listenerCount("close")).toBe(0);
      expect(proxy.recentFailureCount).toBe(0);

      // And it is a restart, not a kill: a different child is now serving.
      expect(proxy.currentChild).not.toBeNull();
      expect(proxy.currentChild?.pid).not.toBe(firstChild?.pid);
    } finally {
      const survivor = proxy.currentChild;
      if (survivor) await proxy.killChild(survivor);
    }
  }, 30_000);
});

describe("readiness-probe helpers (tools.ts)", () => {
  test("buildReadyProbeRequest returns a JSON-RPC ping with the supplied id", () => {
    const req = buildReadyProbeRequest("__proxy_ready_probe_42");
    expect(req).toEqual({
      jsonrpc: "2.0",
      id: "__proxy_ready_probe_42",
      method: "ping",
    });
  });

  test("isReadyProbeResponse recognises ids carrying the reserved prefix", () => {
    expect(
      isReadyProbeResponse({
        jsonrpc: "2.0",
        id: `${PROXY_READY_PROBE_ID_PREFIX}1`,
        result: {},
      })
    ).toBe(true);
  });

  test("isReadyProbeResponse rejects non-probe ids", () => {
    expect(
      isReadyProbeResponse({
        jsonrpc: "2.0",
        id: "regular-request-7",
        result: {},
      })
    ).toBe(false);
  });

  test("isReadyProbeResponse rejects numeric ids", () => {
    expect(
      isReadyProbeResponse({
        jsonrpc: "2.0",
        id: 99,
        result: {},
      })
    ).toBe(false);
  });

  test("isReadyProbeResponse rejects messages with no id (notifications)", () => {
    expect(
      isReadyProbeResponse({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })
    ).toBe(false);
  });

  // mt#4128: the served-tool-count discrimination. The point of the record is
  // to tell a HEALTHY serve from a TOOLLESS one, so both values are asserted —
  // a probe that cannot report the broken case carries no information about the
  // condition it exists for (mem#704).
  test("toolsListCount reports the tool count of a tools/list response", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] },
    };
    expect(toolsListCount(msg)).toBe(3);
  });

  test("toolsListCount reports 0 for a served-but-empty tool list (the toolless case)", () => {
    // The mt#4128 condition's server-side signature: a well-formed response
    // carrying no tools. Distinguishable from `null` (not a tools/list at all),
    // which is the whole reason the return type is `number | null` rather than
    // a falsy count.
    const msg = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    expect(toolsListCount(msg)).toBe(0);
  });

  test("toolsListCount returns null for an error response", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "boom" },
      result: { tools: [] },
    };
    expect(toolsListCount(msg)).toBeNull();
  });

  test("toolsListCount returns null for a non-tools/list message", () => {
    expect(toolsListCount({ jsonrpc: "2.0", id: 1, result: { ok: true } })).toBeNull();
    expect(toolsListCount({ jsonrpc: "2.0", method: NOTIFICATIONS_INITIALIZED })).toBeNull();
  });

  test("buildToolsListChangedNotification returns the standard MCP frame with no id", () => {
    const notif = buildToolsListChangedNotification();
    expect(notif.jsonrpc).toBe("2.0");
    expect(notif.method).toBe(TOOLS_LIST_CHANGED_NOTIFICATION_METHOD);
    expect(notif.method).toBe("notifications/tools/list_changed");
    // JSON-RPC 2.0: notifications MUST omit `id`.
    expect("id" in notif).toBe(false);
  });
});

describe("outbound transform — probe-response interception (mt#2011)", () => {
  let originalStdoutWrite: typeof process.stdout.write;
  let capturedStdout: string[];

  beforeEach(() => {
    capturedStdout = [];
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as Writable).write = ((chunk: unknown) => {
      capturedStdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    (process.stdout as Writable).write = originalStdoutWrite as typeof process.stdout.write;
  });

  // Helper: build a probe-response JSON-RPC frame for the given probe id.
  function probeResponseLine(probeId: string): string {
    return `${JSON.stringify({ jsonrpc: "2.0", id: probeId, result: {} })}\n`;
  }

  // Helper: drain everything pushed through the transform into a flat string.
  function readTransformOutput(t: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve) => {
      const chunks: string[] = [];
      t.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
      t.on("end", () => resolve(chunks.join("")));
    });
  }

  test("swallows the probe response (not forwarded upstream) AND emits notification when spawnCount > 1", async () => {
    const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: ["--version"] });

    // Simulate a respawn state: spawnCount > 1 means notification SHOULD be emitted.
    const probeId = `${PROXY_READY_PROBE_ID_PREFIX}2`;
    // Use a mutable wrapper so TS doesn't narrow the inner type to `null`
    // (the closure assigns inside a callback TS can't prove is sync-invoked).
    const probeState: { reason: "response" | "timeout" | null } = { reason: null };
    let emittedNotification = false;

    (proxy as unknown as { spawnCount: number; pendingProbe: unknown }).spawnCount = 2;
    (proxy as unknown as { pendingProbe: unknown }).pendingProbe = {
      id: probeId,
      timeoutHandle: setTimeout(() => {}, 99_999),
      complete: (reason: "response" | "timeout") => {
        probeState.reason = reason;
        if (reason === "response") {
          // Mimic the production complete() side-effect of emitting the
          // notification upstream when spawnCount > 1.
          emittedNotification = true;
          process.stdout.write(`${JSON.stringify(buildToolsListChangedNotification())}\n`);
        }
        // Clear the slot so the transform's `if probe.id === msg.id` won't
        // re-trigger if the same line arrives twice.
        (proxy as unknown as { pendingProbe: unknown }).pendingProbe = null;
      },
      cancel: () => {},
    };

    const transform = (
      proxy as unknown as { createOutboundTransform: () => NodeJS.ReadWriteStream }
    ).createOutboundTransform();

    // Feed the probe response into the transform.
    (transform as NodeJS.WritableStream).write(probeResponseLine(probeId));
    (transform as NodeJS.WritableStream).end();

    const downstreamOutput = await readTransformOutput(transform as NodeJS.ReadableStream);

    // The probe response itself must NOT appear in the downstream output.
    expect(downstreamOutput).not.toContain(probeId);

    // The probe-completion handler MUST have been invoked with reason="response".
    expect(probeState.reason).toBe("response");

    // And the notification MUST have been emitted to process.stdout.
    expect(emittedNotification).toBe(true);
    const writtenNotifications = capturedStdout.filter((s) =>
      s.includes(TOOLS_LIST_CHANGED_NOTIFICATION_METHOD)
    );
    expect(writtenNotifications).toHaveLength(1);
  });

  test("swallows late/stale probe responses unconditionally (no leak when pendingProbe id mismatches)", async () => {
    // PR #1216 R1 BLOCKING 1+2 regression test. The previous version of this
    // test asserted that an unmatched-id probe response was FORWARDED
    // upstream — that was a bug. The `__proxy_ready_probe_` id namespace is
    // reserved by the proxy; no compliant client should ever send a request
    // with this prefix, so a response carrying this prefix must always be
    // swallowed regardless of whether it matches the currently-outstanding
    // probe. Forwarding would leak proxy-internal traffic onto the wire.
    const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: ["--version"] });

    // Set pendingProbe to id "1", then feed a response with id "2" (LATE/
    // STALE — e.g., the prior probe timed out and a delayed response is
    // arriving, or the child of a prior spawn responded after a respawn).
    (proxy as unknown as { pendingProbe: unknown }).pendingProbe = {
      id: `${PROXY_READY_PROBE_ID_PREFIX}1`,
      timeoutHandle: setTimeout(() => {}, 99_999),
      complete: () => {
        throw new Error("complete must NOT be called when ids do not match");
      },
      cancel: () => {},
    };

    const transform = (
      proxy as unknown as { createOutboundTransform: () => NodeJS.ReadWriteStream }
    ).createOutboundTransform();

    const staleProbeId = `${PROXY_READY_PROBE_ID_PREFIX}2`;
    (transform as NodeJS.WritableStream).write(probeResponseLine(staleProbeId));
    (transform as NodeJS.WritableStream).end();

    const downstreamOutput = await readTransformOutput(transform as NodeJS.ReadableStream);

    // The stale-probe response MUST be swallowed (not appear downstream).
    expect(downstreamOutput).not.toContain(staleProbeId);
    expect(downstreamOutput).not.toContain(PROXY_READY_PROBE_ID_PREFIX);
  });

  test("swallows probe response even when pendingProbe is null (late response after timeout)", async () => {
    // PR #1216 R1 BLOCKING 1 regression test. The bug: after the timeout
    // path cleared pendingProbe, a late ping response from the child would
    // fall through the outbound transform and be forwarded upstream. The
    // fix: swallow by id prefix unconditionally.
    const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: ["--version"] });

    // pendingProbe is null on construction (timeout path also clears it to
    // null) — simulates "timeout already cleared it".
    expect((proxy as unknown as { pendingProbe: unknown }).pendingProbe).toBeNull();

    const transform = (
      proxy as unknown as { createOutboundTransform: () => NodeJS.ReadWriteStream }
    ).createOutboundTransform();

    const lateProbeId = `${PROXY_READY_PROBE_ID_PREFIX}3`;
    (transform as NodeJS.WritableStream).write(probeResponseLine(lateProbeId));
    (transform as NodeJS.WritableStream).end();

    const downstreamOutput = await readTransformOutput(transform as NodeJS.ReadableStream);

    expect(downstreamOutput).not.toContain(lateProbeId);
    expect(downstreamOutput).not.toContain(PROXY_READY_PROBE_ID_PREFIX);
  });

  test("passes ordinary JSON-RPC frames through verbatim (probe interception does not affect non-probe traffic)", async () => {
    const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: ["--version"] });

    const transform = (
      proxy as unknown as { createOutboundTransform: () => NodeJS.ReadWriteStream }
    ).createOutboundTransform();

    const ordinaryResponse = `${JSON.stringify({
      jsonrpc: "2.0",
      id: "regular-7",
      result: { echo: "hi" },
    })}\n`;
    (transform as NodeJS.WritableStream).write(ordinaryResponse);
    (transform as NodeJS.WritableStream).end();

    const downstreamOutput = await readTransformOutput(transform as NodeJS.ReadableStream);
    expect(downstreamOutput).toContain('"id":"regular-7"');
    expect(downstreamOutput).toContain('"echo":"hi"');
  });
});

describe("__proxy_restart_server response — operator nudge (mt#2031)", () => {
  test("PROXY_RESTART_NUDGE_TEXT names /mcp reconnect and the upstream tracking issue", () => {
    expect(PROXY_RESTART_NUDGE_TEXT).toContain("/mcp");
    expect(PROXY_RESTART_NUDGE_TEXT).toContain("anthropics/claude-code#4118");
    expect(PROXY_RESTART_NUDGE_TEXT).toContain("ToolSearch");
  });

  test("handleProxyRestart response embeds the nudge after the restart-confirmation line", async () => {
    // Exercise the real handleProxyRestart() path against a controlled
    // captured-stdout setup. We capture proc.stdout writes, then trigger
    // handleProxyRestart with a synthetic tools/call request. The proxy will:
    //   1. Attempt to kill `this.child` (we set it to null up front to skip
    //      the kill path safely).
    //   2. Call spawnChild() — this tries to spawn a real subprocess. To keep
    //      the test fast and avoid spawning a process, we shortcut by setting
    //      isShuttingDown=true BEFORE invoking handleProxyRestart so spawnChild
    //      returns early without spawning.
    //   3. Send the success response (with nudge appended) to proc.stdout —
    //      this is the path we want to verify.
    //
    // The entire test body (including proxy construction and stdout
    // override) is wrapped in try/finally so the stdout override is restored
    // even if an unrelated exception fires before the handleProxyRestart
    // call — per R1 reviewer NON-BLOCKING #1.
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as Writable).write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: ["--version"] });

      // Short-circuit spawnChild so it doesn't spawn an actual process.
      (proxy as unknown as { isShuttingDown: boolean }).isShuttingDown = true;
      // No child to kill.
      (proxy as unknown as { child: unknown }).child = null;

      const request = {
        jsonrpc: "2.0",
        id: "test-restart-1",
        method: "tools/call",
        params: { name: "__proxy_restart_server" },
      };

      await (
        proxy as unknown as { handleProxyRestart: (req: unknown) => Promise<void> }
      ).handleProxyRestart(request);

      // The proxy should have written exactly one JSON-RPC frame to stdout: the
      // tool-call success response.
      const [responseLine] = captured.filter((s) => s.includes('"id":"test-restart-1"'));
      if (!responseLine) {
        throw new Error("expected handleProxyRestart to write a tool-call response");
      }

      // Parse the response and verify it contains both the restart-confirmation
      // text AND the nudge text.
      const parsed = JSON.parse(responseLine.trim());
      const text = parsed.result.content[0].text as string;
      expect(text).toContain("inner server restarted at");
      expect(text).toContain(PROXY_RESTART_NUDGE_TEXT);
      // The nudge appears after the restart-confirmation line.
      expect(text.indexOf(PROXY_RESTART_NUDGE_TEXT)).toBeGreaterThan(
        text.indexOf("inner server restarted at")
      );
    } finally {
      (process.stdout as Writable).write = originalWrite as typeof process.stdout.write;
    }
  });
});

describe("unknown-cause instrumentation (mt#2830)", () => {
  test("classifyExitForDisconnectLog: SIGKILL classifies as signal_sigkill, not unknown (acceptance test)", async () => {
    const { classifyExitForDisconnectLog } = await import("./proxy");
    expect(classifyExitForDisconnectLog(null, "SIGKILL")).toBe("signal_sigkill");
  });

  test("classifyExitForDisconnectLog: reuses existing taxonomy causes for SIGTERM/SIGINT/SIGHUP", async () => {
    const { classifyExitForDisconnectLog } = await import("./proxy");
    expect(classifyExitForDisconnectLog(null, "SIGTERM")).toBe("signal_sigterm");
    expect(classifyExitForDisconnectLog(null, "SIGINT")).toBe("signal_sigint");
    expect(classifyExitForDisconnectLog(null, "SIGHUP")).toBe("signal_sighup");
  });

  test("classifyExitForDisconnectLog: an unrecognized signal falls back to the legacy generic bucket, not unknown", async () => {
    const { classifyExitForDisconnectLog } = await import("./proxy");
    expect(classifyExitForDisconnectLog(null, "SIGSEGV")).toBe("signal");
  });

  test("classifyExitForDisconnectLog: non-zero exit with no signal is a proxy-observed crash", async () => {
    const { classifyExitForDisconnectLog } = await import("./proxy");
    expect(classifyExitForDisconnectLog(1, null)).toBe("proxy_observed_crash");
  });

  test("classifyExitForDisconnectLog: clean exit (code 0, no signal) maps to server_close", async () => {
    const { classifyExitForDisconnectLog } = await import("./proxy");
    expect(classifyExitForDisconnectLog(0, null)).toBe("server_close");
  });

  test("onChildClose: SIGKILL records a proxy-observed disconnect event with exit diagnostics, not clean_exit", async () => {
    const { MinskyStdioProxy, PROXY_DISCONNECT_SERVER_NAME } = await import("./proxy");
    const { DisconnectTracker } = await import("../disconnect-tracker");

    // In-memory-only tracker (empty persistPath) so this test does no file I/O.
    DisconnectTracker.resetForTest(PROXY_DISCONNECT_SERVER_NAME, "");

    const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: ["--version"] });

    // Seed diagnostic state as spawnChild() would have (mt#2830).
    (proxy as unknown as { stderrTail: string }).stderrTail = "FATAL: out of memory\n";
    (proxy as unknown as { lastTransportEvent: string }).lastTransportEvent =
      '{"jsonrpc":"2.0","id":7,"method":"tools/call"}';
    // Stub the respawn call — onChildClose's non-shutdown path schedules a
    // real spawnChild() 200ms later via setTimeout; a no-op stub keeps this
    // test hermetic. Deliberately NOT setting isShuttingDown=true: that
    // branch calls the REAL process.exit(0) (no test-interceptable `exit`
    // indirection exists on this class, unlike server.ts), which would kill
    // the whole test process.
    (proxy as unknown as { spawnChild: () => Promise<void> }).spawnChild = async () => {};

    (
      proxy as unknown as { onChildClose: (c: number | null, s: NodeJS.Signals | null) => void }
    ).onChildClose(null, "SIGKILL");

    const events = DisconnectTracker.getInstance(PROXY_DISCONNECT_SERVER_NAME).getEvents();
    const recorded = events.find((e) => e.kind === "disconnect");
    if (!recorded) throw new Error("Expected onChildClose to record a disconnect event");

    expect(recorded.serverName).toBe(PROXY_DISCONNECT_SERVER_NAME);
    expect(recorded.cause).toBe("signal_sigkill");
    expect(recorded.cause).not.toBe("unknown");
    expect(recorded.exitCode).toBe(null);
    expect(recorded.signal).toBe("SIGKILL");
    expect(recorded.stderrTail).toBe("FATAL: out of memory\n");
    expect(recorded.lastTransportEvent).toBe('{"jsonrpc":"2.0","id":7,"method":"tools/call"}');
    // The proxy has no tool-call-count visibility — processRoleOverride keeps
    // this escalation-eligible instead of defaulting to "helper".
    expect(recorded.processRole).toBe("main_session");

    // mt#2830 R1 fix (finding 5): onChildClose scheduled a real setTimeout
    // (RESPAWN_DELAY_MS=200ms) that calls the stubbed no-op spawnChild above.
    // Let it fire HERE, inside the test, instead of leaving a dangling timer
    // that outlives the test — the flakiness window the review flagged.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  });

  test("onChildClose: a routine clean exit (code 0, no signal) does NOT record a proxy-side event", async () => {
    const { MinskyStdioProxy, PROXY_DISCONNECT_SERVER_NAME } = await import("./proxy");
    const { DisconnectTracker } = await import("../disconnect-tracker");

    DisconnectTracker.resetForTest(PROXY_DISCONNECT_SERVER_NAME, "");

    const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: ["--version"] });
    // See the note in the previous test — stub spawnChild rather than using
    // isShuttingDown, which would hit a real process.exit(0).
    (proxy as unknown as { spawnChild: () => Promise<void> }).spawnChild = async () => {};

    (
      proxy as unknown as { onChildClose: (c: number | null, s: NodeJS.Signals | null) => void }
    ).onChildClose(0, null);

    const events = DisconnectTracker.getInstance(PROXY_DISCONNECT_SERVER_NAME).getEvents();
    const recorded = events.find((e) => e.kind === "disconnect");
    // Clean staleness_exit-shaped exits are already recorded by the INNER
    // server under its own serverName; the proxy deliberately stays silent
    // here to avoid duplicating that signal under a second bucket.
    expect(recorded).toBeUndefined();

    // mt#2830 R1 fix (finding 5): flush the scheduled respawn timer here too
    // — see the note in the previous test.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  });
});

describe("inbound transform — conversation-identity injection (mt#3285)", () => {
  const CONV_AGENT_ID = "com.anthropic.claude-code:conv:6c6fdc74-d1b5-424f-a854-6f875b977dd2";

  function makeInboundTransform(agentId: string | null): NodeJS.ReadWriteStream {
    // Explicit null/string via the ProxyOptions seam bypasses env resolution,
    // keeping the test hermetic regardless of the environment it runs in.
    const proxy = new MinskyStdioProxy({
      childCommand: "bun",
      childArgs: ["--version"],
      conversationAgentId: agentId,
    });
    return (
      proxy as unknown as { createInboundTransform: () => NodeJS.ReadWriteStream }
    ).createInboundTransform();
  }

  function readTransformOutput(t: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve) => {
      const chunks: string[] = [];
      t.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
      t.on("end", () => resolve(chunks.join("")));
    });
  }

  test("stamps _meta agent_id into tools/call requests when identity is active", async () => {
    const transform = makeInboundTransform(CONV_AGENT_ID);
    const request = {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "tasks_get", arguments: { taskId: "mt#3285" } },
    };

    (transform as NodeJS.WritableStream).write(`${JSON.stringify(request)}\n`);
    (transform as NodeJS.WritableStream).end();
    const output = await readTransformOutput(transform);

    const forwarded = JSON.parse(output.trim()) as {
      params: { _meta: Record<string, unknown>; name: string; arguments: unknown };
    };
    expect(forwarded.params._meta[AGENT_ID_META_KEY]).toBe(CONV_AGENT_ID);
    expect(forwarded.params.name).toBe("tasks_get");
    expect(forwarded.params.arguments).toEqual({ taskId: "mt#3285" });
  });

  test("forwards non-tools/call frames byte-identical (initialize, notifications)", async () => {
    const transform = makeInboundTransform(CONV_AGENT_ID);
    const initLine = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const notifLine = JSON.stringify({ jsonrpc: "2.0", method: NOTIFICATIONS_INITIALIZED });

    (transform as NodeJS.WritableStream).write(`${initLine}\n${notifLine}\n`);
    (transform as NodeJS.WritableStream).end();
    const output = await readTransformOutput(transform);

    expect(output).toBe(`${initLine}\n${notifLine}\n`);
  });

  test("forwards tools/call byte-identical when identity is inactive (hookless env, spec AT3)", async () => {
    const transform = makeInboundTransform(null);
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "tasks_get", arguments: {} },
    });

    (transform as NodeJS.WritableStream).write(`${line}\n`);
    (transform as NodeJS.WritableStream).end();
    const output = await readTransformOutput(transform);

    expect(output).toBe(`${line}\n`);
    expect(output).not.toContain(AGENT_ID_META_KEY);
  });

  test("still intercepts __proxy_restart_server locally (never forwarded, never stamped)", async () => {
    const transform = makeInboundTransform(CONV_AGENT_ID);
    // handleProxyRestart will run against a proxy with no child; it kills
    // nothing and respawns `bun --version`. We only assert the frame is not
    // forwarded downstream — the restart flow itself is covered elsewhere.
    const restartLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "__proxy_restart_server", arguments: {} },
    });

    (transform as NodeJS.WritableStream).write(`${restartLine}\n`);
    (transform as NodeJS.WritableStream).end();
    const output = await readTransformOutput(transform);

    expect(output).toBe("");
  });

  test("preserves an already-declared agent_id instead of overwriting (mt#2292 forward-compat)", async () => {
    const transform = makeInboundTransform(CONV_AGENT_ID);
    const declared = "minsky.native-subagent:run:mt#99@com.anthropic.claude-code:conv:abc";
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "t", arguments: {}, _meta: { [AGENT_ID_META_KEY]: declared } },
    });

    (transform as NodeJS.WritableStream).write(`${line}\n`);
    (transform as NodeJS.WritableStream).end();
    const output = await readTransformOutput(transform);

    // Expectation updated in mt#3986: the frame is no longer passed through
    // byte-identically, because baggage emission is decided independently of
    // agent_id — the caller keeps its declared id AND gains the W3C entry. The
    // mt#2292 property this test exists for (the declared id survives, the
    // proxy's own conversation-grain id does not replace it) is unchanged and
    // asserted below.
    expect(output).toContain(declared);
    expect(output).not.toContain(`"${AGENT_ID_META_KEY}":"${CONV_AGENT_ID}"`);
    expect(output).toContain("baggage");
  });
});
