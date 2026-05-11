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
  augmentToolsListResponse,
  makeToolCallResponse,
  isProxyRestartRequest,
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
    this.spawnChild();

    // Keep process alive until shutdown.
    await new Promise<void>((resolve) => {
      proc.once("exit", resolve);
    });
  }

  /**
   * Spawn the inner server child process and wire stdio pipes.
   * Called on initial start and on each respawn.
   */
  spawnChild(): void {
    if (this.isShuttingDown) return;

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

    log.debug("[proxy] Inner MCP server spawned", { pid: child.pid });
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
      this.spawnChild();
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
   * Inspects each line for `tools/list` responses.
   * Augments matching responses with `__proxy_restart_server`.
   * All other lines are forwarded verbatim.
   *
   * Framing contract: same `\r\n` normalization as the inbound transform —
   * strip trailing `\r` after splitting on `\n` so JSON.parse succeeds
   * regardless of the inner server's line-ending style.
   */
  private createOutboundTransform(): Transform {
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

    // Spawn the fresh child.
    this.spawnChild();

    // Wait a short moment for the child to start before responding.
    // The inner server emits its ready signal; the initialize handshake
    // happens transparently between Claude Code and child over the pipe.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

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
