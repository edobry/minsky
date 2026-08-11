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

import { resolveConversationAgentId, injectAgentIdMeta } from "./identity";
import { readAuthToken, DEFAULT_TOKEN_PATH } from "./token";
import { DaemonClient } from "./client";
import type { JsonRpcMessage } from "./protocol";

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
  /** Injected for tests — defaults to resolving CLAUDE_CODE_SESSION_ID. */
  conversationAgentId?: string | null;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
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

  const conversationAgentId =
    deps.conversationAgentId !== undefined
      ? deps.conversationAgentId
      : resolveConversationAgentId();
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
      void handleLine(line, { client, conversationAgentId, stdout, stderr });
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
  }
): Promise<void> {
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line) as JsonRpcMessage;
  } catch {
    ctx.stderr.write(`[shim] dropping non-JSON stdin line\n`);
    return;
  }

  ctx.client.observeInbound(msg);

  let outgoing = msg;
  if (ctx.conversationAgentId) {
    const injected = injectAgentIdMeta(msg, ctx.conversationAgentId);
    if (injected) outgoing = injected;
  }

  try {
    const responses = await ctx.client.send(outgoing);
    for (const resp of responses) {
      ctx.stdout.write(`${JSON.stringify(resp)}\n`);
    }
  } catch (err) {
    // Never silently drop a message on HTTP failure (the named gap in the
    // mt#3884 spike). A request (has an id) gets a JSON-RPC error frame so
    // the client sees a normal tool-call failure instead of a silent hang;
    // a notification (no id) has no response slot in JSON-RPC 2.0, so it
    // can only be logged.
    const detail = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`[shim] daemon request failed: ${detail}\n`);
    if (msg.id !== undefined && msg.id !== null) {
      ctx.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: `minsky mcp shim: daemon request failed: ${detail}` },
        })}\n`
      );
    }
  }
}
