#!/usr/bin/env bun
/**
 * Minsky stdio respawn proxy — core supervisor.
 *
 * Sits between Claude Code and `minsky mcp start`, transparently absorbs the
 * inner server's `process.exit(0)` from mt#1322's staleness mechanism, and
 * respawns the child without Claude Code observing a disconnect.
 *
 * Architecture: raw stdio pipe (NOT MCP SDK transport re-encoding).
 * - `process.stdin` → `child.stdin` (with intercept for `__proxy_restart_server`)
 * - `child.stdout` → `process.stdout` (with intercept for `tools/list` augmentation)
 *
 * The proxy only parses JSON in two narrow cases:
 *   1. Inbound `tools/call` for `__proxy_restart_server` — handled locally.
 *   2. Outbound `tools/list` response — augmented with `__proxy_restart_server`.
 * All other frames are passed through as raw bytes.
 *
 * Note on process type casts: Bun's built-in `process` type definitions are
 * minimal (missing `.once()`, `.on()`, `.stdin.pipe()`, `.stdin.unpipe()`,
 * `.stdout.pipe()`). We use `(process as any)` casts in the narrow places
 * where the runtime methods exist but types don't. The same pattern is used
 * in src/commands/mcp/start-command.ts.
 *
 * @see docs/architecture/stdio-proxy.md
 * @see mt#1714 — task spec
 * @see mt#1322 — inner-server staleness-exit mechanism
 */

import { spawn, type ChildProcess } from "child_process";
import { Transform, type Readable, type Writable } from "stream";
import { log } from "../../utils/logger";
import {
  PROXY_RESTART_TOOL_NAME,
  PROXY_READY_PROBE_ID_PREFIX,
  augmentToolsListResponse,
  buildReadyProbeRequest,
  buildToolsListChangedNotification,
  makeToolCallResponse,
  isProxyRestartRequest,
  isReadyProbeResponse,
  type JsonRpcMessage,
} from "./tools";

/** Default command for the inner MCP server. */
const DEFAULT_CHILD_COMMAND = "minsky";
/** Default args for the inner MCP server. */
const DEFAULT_CHILD_ARGS = ["mcp", "start"];

/** Grace period after SIGTERM before sending SIGKILL to child. */
const CHILD_SIGTERM_GRACE_MS = 3000;
/** Delay before respawning a child that exited. */
const RESPAWN_DELAY_MS = 200;
/** Maximum consecutive crash failures to allow before giving up. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Window to count failures (ms). */
const FAILURE_WINDOW_MS = 60_000;
/**
 * Timeout (ms) for the ping-based readiness probe sent after each child
 * respawn (mt#2011). On timeout the proxy emits
 * `notifications/tools/list_changed` upstream anyway as a best-effort
 * fallback; better to race with the inner's startup than to silently leave
 * Claude Code's tools cache stale.
 */
const READY_PROBE_TIMEOUT_MS = 2000;

export interface ProxyOptions {
  /** Command to spawn as the inner MCP server. Default: "minsky" */
  childCommand?: string;
  /** Arguments for the inner MCP server command. Default: ["mcp", "start"] */
  childArgs?: string[];
}

/**
 * Cause classification for child process exits.
 * Mirrors the inner server's disconnect-tracker cause classes for human readability.
 */
type ExitCause = "clean_exit" | "signal" | "crash";

function classifyExit(code: number | null, signal: NodeJS.Signals | null): ExitCause {
  if (signal !== null) return "signal";
  if (code === 0) return "clean_exit";
  return "crash";
}

/**
 * Type-cast wrapper so we can call Node.js stream methods that Bun's
 * process type definitions don't expose. Identical to the pattern used in
 * src/commands/mcp/start-command.ts for process.on("SIGTERM", ...).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proc: any = process;

/**
 * MinskyStdioProxy — the respawn supervisor.
 *
 * Lifecycle:
 *   1. `start()` spawns the inner server and wires up stdio pipes.
 *   2. On child exit (clean or crash) when `isShuttingDown=false`, the proxy
 *      respawns the child after a short delay.
 *   3. On SIGTERM/SIGINT, `isShuttingDown=true`, child is signaled, and the
 *      proxy exits cleanly after the child terminates.
 */
export class MinskyStdioProxy {
  private childCommand: string;
  private childArgs: string[];
  private child: ChildProcess | null = null;
  private isShuttingDown = false;
  private recentFailures: number[] = [];
  /**
   * Number of times `spawnChild()` has been invoked successfully across the
   * proxy's lifetime. Used to (a) decide whether to emit
   * `notifications/tools/list_changed` upstream (only on respawns, not the
   * initial spawn — Claude Code's session-start initialize has not yet
   * completed on the first spawn and a notification then would be premature),
   * and (b) generate unique ids for the ping readiness probe so stale
   * responses from prior respawns cannot accidentally resolve the current
   * probe.
   */
  private spawnCount = 0;
  /**
   * Currently outstanding readiness probe. Cleared when the matching response
   * arrives (or the timeout fires). The id is the same value carried on the
   * `ping` request id; the outbound transform compares against this to
   * recognise the probe response and trigger upstream notification emission.
   */
  private pendingProbe: {
    id: string;
    timeoutHandle: ReturnType<typeof setTimeout>;
    /**
     * Completes the probe — clears `this.pendingProbe`, conditionally writes
     * `notifications/tools/list_changed` upstream, then resolves the
     * `spawnChild()` promise. Idempotent: safe to call from either the probe
     * response path or the timeout path.
     */
    complete: (reason: "response" | "timeout") => void;
    /**
     * Cancel the probe without emitting `notifications/tools/list_changed`.
     * Used when a new `spawnChild()` invocation supersedes the prior child
     * before its probe completed (crash-then-respawn). Resolves the prior
     * `spawnChild()` promise without notification side-effects.
     */
    cancel: () => void;
  } | null = null;

  /**
   * Transform stream that sits on the inbound path (stdin → child.stdin).
   * Inspects each newline-delimited JSON-RPC line. On detecting a
   * `tools/call __proxy_restart_server` request, swallows the frame and
   * handles it locally. All other lines are passed through as-is.
   */
  private inboundTransform: Transform | null = null;

  /**
   * Transform stream that sits on the outbound path (child.stdout → stdout).
   * Inspects each newline-delimited JSON-RPC line. On detecting a `tools/list`
   * response, augments it with `__proxy_restart_server`. All other lines are
   * passed through as-is.
   */
  private outboundTransform: Transform | null = null;

  constructor(options: ProxyOptions = {}) {
    this.childCommand = options.childCommand ?? DEFAULT_CHILD_COMMAND;
    this.childArgs = options.childArgs ?? DEFAULT_CHILD_ARGS;
  }

  /** Start the proxy: spawn child and wire stdio. */
  async start(): Promise<void> {
    this.setupSignalHandlers();
    // Fire-and-forget the initial spawn. We don't await the readiness probe
    // here because `start()` should resolve on process exit, not on each
    // child's readiness — the probe runs concurrently and completes via the
    // outbound transform.
    void this.spawnChild().catch((err: Error) => {
      log.error("[proxy] Initial spawnChild failed", { error: err.message });
    });

    // Keep process alive until shutdown.
    await new Promise<void>((resolve) => {
      proc.once("exit", resolve);
    });
  }

  /**
   * Spawn the inner server child process and wire stdio pipes.
   * Called on initial start and on each respawn.
   *
   * Returns a Promise that resolves when the post-spawn readiness probe
   * (mt#2011) completes — either because the inner responded to the
   * synthesized `ping` request (semantic readiness signal: the inner's
   * protocol layer is operational), or because the
   * `READY_PROBE_TIMEOUT_MS` fallback elapsed. On respawns (spawnCount > 1)
   * the probe completion also writes `notifications/tools/list_changed`
   * upstream so Claude Code refreshes its `tools/list` cache without
   * needing `/mcp` reconnect.
   *
   * The async return shape lets `handleProxyRestart()` `await spawnChild()`
   * and send its tool-call success response only after the notification has
   * been emitted (ensuring Claude Code sees notification-then-response, not
   * response-then-notification with a race window in between). `start()`
   * and `onChildClose()` ignore the returned promise (fire-and-forget) since
   * they do not need to sequence anything after probe completion.
   */
  async spawnChild(): Promise<void> {
    if (this.isShuttingDown) return;

    // Cancel any probe outstanding from a prior child (mt#2011). The prior
    // child's stdio is being replaced; that probe will never receive a
    // response. Cancelling clears its timeout, resolves the prior
    // spawnChild() promise, and DOES NOT emit a stale notification — the
    // new probe will emit one if appropriate.
    if (this.pendingProbe !== null) {
      log.debug("[proxy] Cancelling pending probe from prior child", {
        probeId: this.pendingProbe.id,
      });
      this.pendingProbe.cancel();
    }

    log.debug("[proxy] Spawning inner MCP server", {
      command: this.childCommand,
      args: this.childArgs,
    });

    const child = spawn(this.childCommand, this.childArgs, {
      // stdin: pipe so we can write to it
      // stdout: pipe so we can read and intercept
      // stderr: inherit so inner server logs surface directly
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child = child;

    // Wire the inbound path: stdin → inbound-transform → child.stdin
    this.inboundTransform = this.createInboundTransform();
    (proc.stdin as Readable).pipe(this.inboundTransform).pipe(child.stdin as Writable);

    // Wire the outbound path: child.stdout → outbound-transform → stdout
    this.outboundTransform = this.createOutboundTransform();
    (child.stdout as Readable).pipe(this.outboundTransform).pipe(proc.stdout as Writable);

    child.on("error", (err) => {
      log.error("[proxy] Child process error", { error: err.message });
    });

    // Store close handler reference so handleProxyRestart can remove it before
    // killing the child. Without removal, killing fires close → onChildClose →
    // schedules a respawn PLUS handleProxyRestart calls spawnChild directly =
    // double-spawn. See BLOCKING 1 in PR #1039 R1 reviewer findings.
    const closeHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      this.onChildClose(code, signal);
    };
    child.on("close", closeHandler);
    // Attach the handler reference so handleProxyRestart can detach it before
    // killing the child (preventing the double-spawn race). ChildProcess has no
    // _proxyCloseHandler field in its type definition; the as-unknown cast is the
    // only way to attach this side-channel without modifying the ChildProcess type.
    // eslint-disable-next-line custom/no-excessive-as-unknown -- side-channel property on ChildProcess, no alternative
    (child as unknown as { _proxyCloseHandler: typeof closeHandler })._proxyCloseHandler =
      closeHandler;

    this.spawnCount += 1;
    log.debug("[proxy] Inner MCP server spawned", {
      pid: child.pid,
      spawnCount: this.spawnCount,
    });

    // Send the ping readiness probe and await its completion (response or
    // timeout). On respawns (spawnCount > 1), completion also writes
    // `notifications/tools/list_changed` upstream.
    const emitToolsListChanged = this.spawnCount > 1;
    await this.runReadyProbe(child, emitToolsListChanged);
  }

  /**
   * Send a `ping` request to the freshly-spawned child and resolve when the
   * matching response arrives (the outbound transform intercepts it and calls
   * `pendingProbe.complete("response")`) or when `READY_PROBE_TIMEOUT_MS`
   * elapses. When `emitNotification` is true, completion writes
   * `notifications/tools/list_changed` to `process.stdout` so Claude Code
   * refreshes its tools cache (mt#2011).
   *
   * The probe id carries the reserved `__proxy_ready_probe_<spawnCount>`
   * prefix; the outbound transform recognises it by prefix and discards
   * the response (it is never forwarded upstream).
   */
  private runReadyProbe(child: ChildProcess, emitNotification: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.isShuttingDown) {
        resolve();
        return;
      }

      const probeId = `${PROXY_READY_PROBE_ID_PREFIX}${this.spawnCount}`;
      let completed = false;

      const complete = (reason: "response" | "timeout"): void => {
        if (completed) return;
        completed = true;

        // Clear pendingProbe iff it still refers to this probe (defensive:
        // a subsequent respawn may have already overwritten it).
        if (this.pendingProbe?.id === probeId) {
          clearTimeout(this.pendingProbe.timeoutHandle);
          this.pendingProbe = null;
        }

        // Defensive guard (PR #1216 R1 NON-BLOCKING 2): if the timeout fires
        // for a child that has already exited (rare race where the close
        // handler hasn't yet scheduled the respawn-side cancel), skip the
        // notification — the subsequent respawn's probe will emit one with
        // a live child. Race detection: `this.child` is set to the most-
        // recent spawned child; we cancelled-or-completed any prior probe
        // at the top of spawnChild(), so if `this.child !== child` here, a
        // newer spawn has already taken over and is responsible for its
        // own notification.
        const childStillCurrent =
          reason === "response" || (this.child === child && child.exitCode === null);

        if (emitNotification && childStillCurrent) {
          log.debug("[proxy] Emitting tools/list_changed notification", {
            probeId,
            reason,
          });
          try {
            (proc.stdout as Writable).write(
              `${JSON.stringify(buildToolsListChangedNotification())}\n`
            );
          } catch (err) {
            log.error("[proxy] Failed to write tools/list_changed", {
              error: (err as Error).message,
            });
          }
        } else if (emitNotification && !childStillCurrent) {
          log.debug("[proxy] Skipping tools/list_changed — child no longer current", {
            probeId,
            reason,
            childExitCode: child.exitCode,
          });
        } else {
          log.debug("[proxy] Initial spawn — skipping tools/list_changed", {
            probeId,
            reason,
          });
        }

        resolve();
      };

      const cancel = (): void => {
        if (completed) return;
        completed = true;
        if (this.pendingProbe?.id === probeId) {
          clearTimeout(this.pendingProbe.timeoutHandle);
          this.pendingProbe = null;
        }
        // Resolve the spawnChild() promise WITHOUT emitting the notification
        // — the new spawn will emit if appropriate.
        resolve();
      };

      const timeoutHandle = setTimeout(() => complete("timeout"), READY_PROBE_TIMEOUT_MS);
      this.pendingProbe = {
        id: probeId,
        timeoutHandle,
        complete,
        cancel,
      };

      try {
        const probeRequest = buildReadyProbeRequest(probeId);
        (child.stdin as Writable).write(`${JSON.stringify(probeRequest)}\n`);
        log.debug("[proxy] Ready probe sent", { probeId });
      } catch (err) {
        log.error("[proxy] Failed to send ready probe", {
          probeId,
          error: (err as Error).message,
        });
        complete("timeout");
      }
    });
  }

  /**
   * Handle child close event. Classifies the exit cause and respawns if
   * we are not in a shutdown state.
   */
  private onChildClose(code: number | null, signal: NodeJS.Signals | null): void {
    const cause = classifyExit(code, signal);
    log.debug("[proxy] Inner MCP server exited", { cause, code, signal });

    // Capture and clear this.child before tearDownPipes so the child streams
    // are still accessible for unpipe even though this.child is now null.
    const closedChild = this.child;
    this.child = null;

    // Tear down the old pipe connections so we can create new ones on respawn.
    this.tearDownPipes(closedChild ?? undefined);

    if (this.isShuttingDown) {
      log.debug("[proxy] Shutdown complete; proxy exiting");
      process.exit(0);
    }

    // Track failure cadence to avoid infinite restart loops for crashes.
    const now = Date.now();
    this.recentFailures = this.recentFailures.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (cause === "crash") {
      this.recentFailures.push(now);
    }

    if (this.recentFailures.length >= MAX_CONSECUTIVE_FAILURES) {
      log.error("[proxy] Too many consecutive crash failures; giving up", {
        failureCount: this.recentFailures.length,
        windowMs: FAILURE_WINDOW_MS,
      });
      process.exit(1);
    }

    // Schedule respawn.
    log.debug("[proxy] Scheduling respawn", { delayMs: RESPAWN_DELAY_MS, cause });
    setTimeout(() => {
      // Fire-and-forget: spawnChild() is now async (mt#2011) because it
      // awaits the readiness probe; onChildClose does not need to sequence
      // anything after probe completion. The probe handles its own logging
      // on failure, and notification emission is internal to the probe's
      // completion path.
      void this.spawnChild().catch((err: Error) => {
        log.error("[proxy] Respawn after close failed", { error: err.message });
      });
    }, RESPAWN_DELAY_MS);
  }

  /**
   * Unpipe and destroy the current Transform streams so they don't
   * hold references to the dead child process.
   *
   * @param child - The child process being torn down. When provided, also
   *   unpipes the child-side connections:
   *   - `inboundTransform.unpipe(child.stdin)` — detaches the inbound
   *     transform from the old child's stdin.
   *   - `child.stdout.unpipe(outboundTransform)` — detaches the old child's
   *     stdout from the outbound transform.
   *   Without these, the transform streams hold stale references to the dead
   *   child's streams (BLOCKING 2 in PR #1039 R1 reviewer findings).
   */
  private tearDownPipes(child?: ChildProcess): void {
    if (this.inboundTransform) {
      (proc.stdin as Readable).unpipe(this.inboundTransform);
      // Also detach the inbound transform from the child's stdin so it doesn't
      // hold a stale reference to the dead child's stdin stream.
      if (child?.stdin) {
        this.inboundTransform.unpipe(child.stdin as Writable);
      }
      this.inboundTransform = null;
    }
    if (this.outboundTransform) {
      // Detach the old child's stdout from the outbound transform before
      // clearing the transform reference.
      if (child?.stdout) {
        (child.stdout as Readable).unpipe(this.outboundTransform);
      }
      this.outboundTransform.unpipe(proc.stdout as Writable);
      this.outboundTransform = null;
    }
  }

  /**
   * Create the inbound transform stream.
   * Inspects each line for `tools/call __proxy_restart_server`.
   * Matching lines are intercepted and handled locally.
   * All other lines are forwarded verbatim.
   *
   * Framing contract: MCP's stdio transport uses newline-delimited JSON-RPC
   * (one JSON object per line, separated by `\n`). Some environments emit
   * `\r\n` line endings (Windows hosts, certain shell wrappers). We normalize
   * by stripping a trailing `\r` from each line after the `\n` split so that
   * `JSON.parse` succeeds regardless of the upstream line-ending style.
   * Per-frame size protection is out of scope for this transform.
   */
  private createInboundTransform(): Transform {
    const proxy = this;
    let inBuffer = "";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = new (Transform as any)() as Transform;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t as any)._transform = (chunk: unknown, _encoding: string, callback: () => void) => {
      inBuffer += String(chunk);
      const lines = inBuffer.split("\n");
      // Keep the last (possibly incomplete) segment in the buffer.
      inBuffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        // Strip trailing \r to handle \r\n line endings (NON-BLOCKING 2, PR #1039 R1).
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line.trim()) {
          // Pass empty lines through (JSON-RPC framing whitespace).
          t.push(`${line}\n`);
          continue;
        }
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if (isProxyRestartRequest(msg)) {
            // Handle locally — do NOT forward to child.
            proxy.handleProxyRestart(msg).catch((err: Error) => {
              log.error("[proxy] Restart handler failed", { error: err.message });
            });
            continue;
          }
        } catch {
          // Not valid JSON — pass through as-is (defensive).
        }
        t.push(`${line}\n`);
      }
      callback();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t as any)._flush = (callback: () => void) => {
      if (inBuffer) {
        t.push(inBuffer);
      }
      callback();
    };
    return t;
  }

  /**
   * Create the outbound transform stream.
   * Inspects each line for two interception cases:
   *   1. `tools/list` responses — augmented with `__proxy_restart_server`.
   *   2. Readiness-probe responses (mt#2011) — swallowed (not forwarded
   *      upstream); triggers `pendingProbe.complete("response")` which on
   *      respawns also writes `notifications/tools/list_changed` upstream.
   * All other lines are forwarded verbatim.
   *
   * Framing contract: same `\r\n` normalization as the inbound transform —
   * strip trailing `\r` after splitting on `\n` so JSON.parse succeeds
   * regardless of the inner server's line-ending style.
   */
  private createOutboundTransform(): Transform {
    const proxy = this;
    let outBuffer = "";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = new (Transform as any)() as Transform;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t as any)._transform = (chunk: unknown, _encoding: string, callback: () => void) => {
      outBuffer += String(chunk);
      const lines = outBuffer.split("\n");
      outBuffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        // Strip trailing \r to handle \r\n line endings (NON-BLOCKING 2, PR #1039 R1).
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line.trim()) {
          t.push(`${line}\n`);
          continue;
        }
        let outputLine = line;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if (isReadyProbeResponse(msg)) {
            // Swallow ANY response carrying the reserved
            // `__proxy_ready_probe_` id prefix — never forward upstream
            // (mt#2011, PR #1216 R1 BLOCKING 1). The id namespace is
            // reserved by the proxy; no compliant client should ever send
            // a request with this prefix, so a response with the prefix is
            // always either:
            //   (a) the response to a currently-outstanding probe — trigger
            //       `pendingProbe.complete("response")` which emits
            //       `notifications/tools/list_changed` upstream on respawns
            //       (spawnCount > 1).
            //   (b) a LATE response arriving after the 2s timeout has
            //       already fired and cleared `pendingProbe` — swallow it
            //       silently (the timeout path already emitted the
            //       notification best-effort; emitting again would be a
            //       duplicate, and forwarding the response upstream would
            //       leak proxy-internal traffic onto the wire).
            //   (c) a STALE response from a prior probe whose child was
            //       superseded by a respawn — swallow silently for the
            //       same reason as (b).
            const probe = proxy.pendingProbe;
            if (probe !== null && probe.id === msg.id) {
              probe.complete("response");
            } else {
              log.debug("[proxy] Swallowed late/stale probe response", {
                id: msg.id,
                pendingProbeId: probe?.id ?? null,
              });
            }
            continue;
          }
          const augmented = augmentToolsListResponse(msg);
          if (augmented !== msg) {
            outputLine = JSON.stringify(augmented);
          }
        } catch {
          // Not valid JSON — pass through as-is.
        }
        t.push(`${outputLine}\n`);
      }
      callback();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t as any)._flush = (callback: () => void) => {
      if (outBuffer) {
        t.push(outBuffer);
      }
      callback();
    };
    return t;
  }

  /**
   * Handle an agent-initiated `__proxy_restart_server` tool call.
   * 1. Kills the current child (SIGTERM with grace period).
   * 2. Waits for the child to exit.
   * 3. Spawns a fresh child.
   * 4. Sends the tool-call response back on stdout.
   */
  async handleProxyRestart(request: JsonRpcMessage): Promise<void> {
    log.debug("[proxy] Agent-initiated restart requested");

    // Kill the current child gracefully.
    // BLOCKING 1 fix: detach the old child's close listener BEFORE killing it.
    // Without this, killing the child fires the close event → onChildClose runs
    // → schedules a respawn via setTimeout. handleProxyRestart also calls
    // spawnChild() directly below → double-spawn. Removing the listener first
    // ensures only one spawnChild call happens (the direct call below).
    if (this.child && this.child.pid) {
      const oldChild = this.child;
      this.child = null;

      // Detach the close listener so onChildClose does not fire when we kill
      // the child here. The listener reference was stored on the child object
      // by spawnChild() for exactly this purpose. The as-unknown cast is
      // necessary to read the _proxyCloseHandler side-channel property that has
      // no corresponding field in the ChildProcess type definition.
      // eslint-disable-next-line custom/no-excessive-as-unknown -- read side-channel property; same as the write in spawnChild
      const handlerHost = oldChild as unknown as {
        _proxyCloseHandler?: (code: number | null, signal: NodeJS.Signals | null) => void;
      };
      const handler = handlerHost._proxyCloseHandler;
      if (handler) {
        oldChild.removeListener("close", handler);
      }

      // Tear down old pipes before killing so streams are cleanly disconnected.
      this.tearDownPipes(oldChild);

      await this.killChild(oldChild);
    } else {
      // No live child; still tear down any stale pipes.
      this.tearDownPipes();
    }

    // Spawn the fresh child and await its readiness probe (mt#2011). The
    // probe is the semantic ready signal — successful ping response = inner's
    // protocol layer is operational. Completion also emits
    // `notifications/tools/list_changed` upstream so Claude Code refreshes
    // its tools cache before this method writes the tool-call success
    // response below; the client therefore sees notification-then-response,
    // not response-then-notification with a race window in between.
    // Replaces the prior blanket 300ms wait.
    await this.spawnChild();

    // Send the tool-call response back to Claude Code.
    const response = makeToolCallResponse(
      request,
      `${PROXY_RESTART_TOOL_NAME}: inner server restarted at ${new Date().toISOString()}`
    );
    (proc.stdout as Writable).write(`${JSON.stringify(response)}\n`);

    log.debug("[proxy] Agent-initiated restart complete");
  }

  /**
   * Kill a child process gracefully: SIGTERM → SIGKILL after grace period.
   * Returns when the child has actually exited.
   */
  async killChild(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!child.pid || child.exitCode !== null) {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      const killTimeout = setTimeout(() => {
        if (!resolved) {
          log.debug("[proxy] Child did not exit on SIGTERM; sending SIGKILL");
          try {
            child.kill("SIGKILL");
          } catch {
            // Already dead.
          }
        }
      }, CHILD_SIGTERM_GRACE_MS);

      child.once("close", () => {
        clearTimeout(killTimeout);
        done();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimeout);
        done();
      }
    });
  }

  /**
   * Install SIGTERM and SIGINT handlers.
   * Sets `isShuttingDown=true`, forwards the signal to the child,
   * then exits after the child terminates (or times out).
   */
  private setupSignalHandlers(): void {
    const handleSignal = async (signal: NodeJS.Signals) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      log.debug("[proxy] Signal received; shutting down", { signal });

      if (this.child && this.child.pid) {
        await this.killChild(this.child);
      }

      process.exit(0);
    };

    proc.on("SIGTERM", () => void handleSignal("SIGTERM"));
    proc.on("SIGINT", () => void handleSignal("SIGINT"));
  }

  /** For testing: expose internal state. */
  get currentChild(): ChildProcess | null {
    return this.child;
  }

  /** For testing: expose shutdown state. */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }
}

/**
 * Main entry point — called from the CLI subcommand.
 */
export async function runProxy(options: ProxyOptions = {}): Promise<void> {
  const proxy = new MinskyStdioProxy(options);
  await proxy.start();
}
