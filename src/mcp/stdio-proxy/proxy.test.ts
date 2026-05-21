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
import { MinskyStdioProxy } from "./proxy";
import {
  PROXY_READY_PROBE_ID_PREFIX,
  PROXY_RESTART_NUDGE_TEXT,
  TOOLS_LIST_CHANGED_NOTIFICATION_METHOD,
  buildReadyProbeRequest,
  buildToolsListChangedNotification,
  isReadyProbeResponse,
} from "./tools";

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
    const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: ["--version"] });

    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as Writable).write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

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

    try {
      await (
        proxy as unknown as { handleProxyRestart: (req: unknown) => Promise<void> }
      ).handleProxyRestart(request);
    } finally {
      (process.stdout as Writable).write = originalWrite as typeof process.stdout.write;
    }

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
  });
});
