/**
 * `minsky mcp shim` core — testable module (mt#3812, ADR-038).
 *
 * Reads newline-delimited JSON-RPC from stdin, stamps conversation identity
 * onto `tools/call` requests, forwards to the shared HTTP daemon via
 * DaemonClient, and writes the daemon's response(s) back to stdout as
 * newline-delimited JSON-RPC.
 *
 * This file has NO top-level side effects on import (no stdin listeners
 * attached, no process wired) so it can be unit-tested directly —
 * `entry.ts` is the thin executable that calls `runShim` unconditionally,
 * matching the split already used by src/cli.ts (executable, side-effecting)
 * vs. the modules it imports (testable, side-effect-free on import).
 *
 * MUST NOT import anything from src/cli.ts, src/commands/**, or the shared
 * command registry/DI container — see entry.ts's docblock and the mt#3812
 * spec's BLOCKING section for why.
 */

import {
  injectAgentIdMeta,
  resolveConversationAgentId,
  resolveHarnessPid,
  resolveLiveConversationAgentId,
} from "./identity";
import { stripUnsupportedCapabilities } from "./capabilities";
import { readAuthToken, DEFAULT_TOKEN_PATH } from "./token";
import { DaemonClient, describeDaemonFailure } from "./client";
import { makeErrorResponse, toolsListCount, type JsonRpcMessage } from "./protocol";
import { boundOversizedResponse, type ResponseBoundDeps } from "./response-bound";

/** Fixed default daemon port per ADR-038 §Question 4. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:48765/mcp";

export interface ShimOptions {
  url: string;
  tokenPath: string;
}

/** Parse `minsky mcp shim [--url <daemon-url>] [--token-file <path>]`. */
export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): ShimOptions {
  let url = env["MINSKY_SHIM_DAEMON_URL"] ?? DEFAULT_DAEMON_URL;
  let tokenPath = env["MINSKY_LOCAL_MCP_TOKEN_PATH"] ?? DEFAULT_TOKEN_PATH;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1] !== undefined) {
      url = argv[++i] as string;
    } else if (argv[i] === "--token-file" && argv[i + 1] !== undefined) {
      tokenPath = argv[++i] as string;
    }
  }

  return { url, tokenPath };
}

export interface ShimDeps {
  /** Injected for tests. */
  client?: DaemonClient;
  /**
   * Injected for tests — defaults to resolving CLAUDE_CODE_SESSION_ID.
   *
   * This is the FALLBACK identity, not the stamped one: supplying it also
   * declares that the caller is CONTROLLING identity, which suppresses the live
   * pid-mapping lookup (see {@link ShimDeps.harnessPid}).
   */
  conversationAgentId?: string | null;
  /**
   * Injected for tests — the harness-pid SEED for the live mapping lookup
   * (mt#4440). Defaults to the ancestor walk, or to `null` when the caller
   * supplied `conversationAgentId`.
   */
  harnessPid?: number | null;
  /**
   * Injected for tests — the PER-FRAME identity resolver (mt#4440).
   *
   * Exists so the property that actually broke — that the stamped id is
   * recomputed per frame rather than frozen at startup — is observable without
   * patching a module this file reaches itself. Defaults to the live resolver
   * over {@link ShimDeps.harnessPid} and the spawn-time env fallback.
   */
  resolveAgentId?: () => string | null;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** Injected for tests — see {@link handleLine}'s `responseBoundDeps`. */
  responseBoundDeps?: ResponseBoundDeps;
}

/**
 * Wire the shim: attach stdin line handling, forward each line through
 * identity injection + the daemon client, write responses to stdout, and
 * install SIGTERM/SIGINT handlers that DELETE the daemon session before
 * exiting (Scope: "so the daemon's idle reaper is not the only thing that
 * frees a per-session Server instance").
 *
 * Returns immediately after wiring — this does not block until shutdown;
 * the process stays alive because stdin has an active listener.
 */
export function runShim(options: ShimOptions, deps: ShimDeps = {}): DaemonClient {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  // The spawn-time env value. It is the FALLBACK, never the stamped id on its
  // own: Claude Code freezes `CLAUDE_CODE_SESSION_ID` in this process's
  // environment when it spawns us, and a `/clear` changes the conversation
  // WITHOUT respawning MCP servers — so a long-lived shim keeps stamping a
  // conversation that ended days ago (mt#4440).
  const conversationAgentId =
    deps.conversationAgentId !== undefined
      ? deps.conversationAgentId
      : resolveConversationAgentId();

  // mt#4440: the harness-pid SEED for the live mapping lookup. The ancestor walk
  // shells out to `ps`, and the pid cannot change for this process's lifetime,
  // so it is resolved ONCE here and never per frame.
  //
  // A caller that supplied `conversationAgentId` explicitly is CONTROLLING
  // identity — including `null` for "identity inactive" — so the mapping must
  // not override it. Only the default path consults the mapping. Without this,
  // a test asking for an inactive identity would still get one from whatever
  // mapping happens to exist on the machine running the suite. Mirrors the
  // stdio proxy's constructor rule exactly.
  const harnessPid =
    deps.harnessPid !== undefined
      ? deps.harnessPid
      : deps.conversationAgentId !== undefined
        ? null
        : resolveHarnessPid();

  // Resolved PER FRAME rather than once, which is the whole fix: the mapping a
  // SessionStart hook writes is what notices a `/clear`, and a value computed at
  // startup structurally cannot. Reads are TTL-cached inside the resolver, so a
  // burst of frames pays one file read between them.
  const currentConversationAgentId =
    deps.resolveAgentId ??
    ((): string | null => resolveLiveConversationAgentId(harnessPid, conversationAgentId));
  const authToken = readAuthToken(options.tokenPath);
  const client =
    deps.client ??
    new DaemonClient({
      url: options.url,
      authToken,
      onLog: (line) => stderr.write(`${line}\n`),
    });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void client.closeSession().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  let buffer = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) continue;
      void handleLine(line, {
        client,
        conversationAgentId: currentConversationAgentId(),
        stdout,
        stderr,
        responseBoundDeps: deps.responseBoundDeps,
      });
    }
  });
  stdin.on("end", shutdown);

  return client;
}

/**
 * Handle one stdin JSON-RPC line: inject identity, forward to the daemon,
 * write the response(s) to stdout. Exported for direct unit testing without
 * going through the stdin plumbing.
 */
export async function handleLine(
  line: string,
  ctx: {
    client: DaemonClient;
    conversationAgentId: string | null;
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
    /**
     * Injected for tests — overrides `boundOversizedResponse`'s filesystem
     * seam (mt#4749). Defaults to the real state dir / fs when omitted, which
     * is what every non-test caller (`runShim`) relies on.
     */
    responseBoundDeps?: ResponseBoundDeps;
  }
): Promise<void> {
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line) as JsonRpcMessage;
  } catch {
    ctx.stderr.write(`[shim] dropping non-JSON stdin line\n`);
    return;
  }

  let outgoing = msg;
  if (ctx.conversationAgentId) {
    const injected = injectAgentIdMeta(msg, ctx.conversationAgentId);
    if (injected) outgoing = injected;
  }

  // mt#4450: a client capability is a claim about this CONNECTION, and this
  // connection cannot carry a server-initiated request (see capabilities.ts).
  // Applied to `outgoing`, not `msg`, so the two transforms compose — they
  // never both fire today (one matches `initialize`, the other `tools/call`),
  // but chaining them is what makes that a fact about the methods rather than
  // a dependency on the order this function happens to run them in.
  const narrowed = stripUnsupportedCapabilities(outgoing);
  if (narrowed) outgoing = narrowed;

  // Observe the OUTGOING message, not the original — and this ordering is
  // load-bearing rather than tidy. `observeInbound` stores the `initialize`
  // request for REPLAY: `reinitialize()` re-sends it verbatim when the daemon
  // reports the transport session gone (`SessionNotFoundError`). Observing
  // `msg` here would stash the un-narrowed declaration and re-advertise
  // `elicitation` on every session recovery, so the fix above would hold only
  // until the first reconnect — the kind of regression that reappears under
  // exactly the conditions nobody reproduces on purpose.
  ctx.client.observeInbound(outgoing);

  try {
    const responses = await ctx.client.send(outgoing);
    for (const resp of responses) {
      // mt#4128: record the tool list this conversation was actually served.
      //
      // The condition this exists for: a conversation can hold ZERO
      // `mcp__minsky__*` tools for its entire life while every process stays
      // healthy and `claude mcp list` reports the server Connected. The client
      // caches whatever `tools/list` it first receives and does not refresh on
      // `notifications/tools/list_changed` (mt#2030,
      // anthropics/claude-code#4118), so one bad list is permanent for that
      // conversation. Without this line there is no record, anywhere, of
      // whether a list was served or how big it was — which is why the
      // 2026-08-13 occurrence could not be diagnosed after the fact.
      //
      // stderr, NOT `log.*`, and that is the point rather than a style choice:
      // `resolveDiagnosticSink` returns the `agent` sink — structured JSON on
      // STDOUT — whenever `MINSKY_LOG_MODE=STRUCTURED` or
      // `ENABLE_AGENT_LOGS=true` is set (packages/shared/src/logger.ts:136).
      // stdout here IS the JSON-RPC channel, so routing this record through the
      // logger would let a diagnostic for channel corruption become a cause of
      // it. The shim already writes its other diagnostics to stderr for the
      // same reason.
      // Guarded, and the guard is the load-bearing part (PR #3038 R1). This
      // write sits INSIDE the same `try` that converts a throw into a
      // "daemon request failed" JSON-RPC error frame below. Unguarded, an
      // EPIPE on stderr — a closed diagnostic stream, which says nothing about
      // the daemon — would be reported to the client as a daemon failure AND
      // would skip forwarding a response that actually succeeded. A diagnostic
      // must never be able to change what the client receives.
      try {
        const servedCount = toolsListCount(resp);
        if (servedCount !== null) {
          ctx.stderr.write(`[shim] tools/list served: ${servedCount} tool(s)\n`);
        }
      } catch {
        // intentional-swallow: the served-count record is diagnostic only, and
        // there is nowhere to report a failure to write a diagnostic except the
        // stream that just failed.
      }

      // mt#4749: the last checkpoint before the write that IS the JSON-RPC
      // channel to the harness. A response whose serialized size runs into the
      // tens of megabytes killed that connection outright (twice, once per
      // server alias) in the originating incident — `boundOversizedResponse`
      // spools an oversized frame to a file and substitutes a bounded error
      // response instead, so this write can never itself take the transport
      // down regardless of which tool produced the oversized result.
      const bounded = boundOversizedResponse(resp, ctx.responseBoundDeps);
      ctx.stdout.write(`${JSON.stringify(bounded)}\n`);
    }
  } catch (err) {
    // Never silently drop a message on HTTP failure (the named gap in the
    // mt#3884 spike). A request (has an id) gets a JSON-RPC error frame so
    // the client sees a normal tool-call failure instead of a silent hang;
    // a notification (no id) has no response slot in JSON-RPC 2.0, so it
    // can only be logged.
    // mt#4466: the top-level text now NAMES the condition. It used to be
    // `daemon request failed:` for every failure, so "nothing is listening" and
    // "the daemon accepted this and went quiet" — opposite conditions with
    // opposite remedies — produced an identical first line. In mem#1120 R2 that
    // read as a broken transport and sent two `/mcp` reconnects at the wrong
    // process while the actual fault was the daemon's connection pool.
    const { summary, detail } = describeDaemonFailure(err);
    ctx.stderr.write(`[shim] ${summary}: ${detail}\n`);
    if (msg.id !== undefined && msg.id !== null) {
      ctx.stdout.write(
        `${JSON.stringify(
          makeErrorResponse(msg.id, -32000, `minsky mcp shim: ${summary}: ${detail}`)
        )}\n`
      );
    }
  }
}
