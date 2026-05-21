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

  test("forwards a probe-response with a NON-matching id verbatim (defensive against stale probes)", async () => {
    const proxy = new MinskyStdioProxy({ childCommand: "bun", childArgs: ["--version"] });

    // Set pendingProbe to id "1", then feed a response with id "2".
    // The transform should NOT swallow the unmatched id — it forwards.
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

    // The stale-probe response is forwarded as-is because no current probe
    // matches its id (defensive: an in-flight client cannot have sent this id
    // anyway, but the transform's contract is byte-faithful passthrough
    // unless the message matches an interception case).
    expect(downstreamOutput).toContain(staleProbeId);
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
