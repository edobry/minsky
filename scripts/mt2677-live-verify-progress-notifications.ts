#!/usr/bin/env bun
/**
 * Live MCP-transport verification for mt#2677 (progress-capture harness).
 *
 * mt#2677 wired `notifications/progress` end-to-end so a long
 * `session_pr_wait-for-review` / `session_pr_drive` poll produces MCP
 * transport activity instead of total silence. That wiring is unit-tested
 * at every layer (see `src/mcp/server.test.ts`'s `buildProgressReporter`
 * suite and `pr-wait-for-review-subcommand.test.ts`'s onProgress-cadence
 * test), but neither test drives a REAL MCP stdio transport end-to-end —
 * they call the functions directly with injected fakes.
 *
 * This script closes that gap: it spawns THIS session's own MCP stdio
 * server (running the session's fixed source, not a published build),
 * performs the MCP `initialize` handshake as a minimal raw JSON-RPC client,
 * requests progress via `_meta.progressToken` on a `session.pr.wait-for-review`
 * call against a REAL open PR, and prints every `notifications/progress`
 * frame it observes before the terminal REVIEW_TIMEOUT/matched response.
 *
 * Design notes:
 * - `since` is set far in the future so any existing review on the target
 *   PR is deterministically rejected by the `since` filter — this forces
 *   the wait to actually poll (and therefore emit progress) instead of
 *   matching immediately on poll 1, regardless of the target PR's live
 *   review state at the time this script runs. REVIEW_TIMEOUT is the
 *   expected (and sufficient) terminal state; the observation this script
 *   cares about is the progress notifications received DURING the wait,
 *   not the terminal state itself.
 * - Uses the MCP stdio wire framing directly (newline-delimited JSON-RPC,
 *   per `@modelcontextprotocol/sdk`'s `ReadBuffer`/`serializeMessage`) —
 *   no SDK client dependency, so this script has no new runtime deps.
 * - Read-only: `session.pr.wait-for-review` never mutates the target PR.
 *
 * Usage: bun scripts/mt2677-live-verify-progress-notifications.ts [task]
 *   task defaults to "mt#2696" (an open PR available at authoring time).
 *
 * Exit codes: 0 = at least one notifications/progress frame observed AND a
 * terminal tool response received. 1 = no config / spawn failure. 2 = ran
 * to completion but observed zero progress frames (the regression this
 * script exists to catch).
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_PATH = join(homedir(), ".config", "minsky", "config.yaml");
if (!existsSync(CONFIG_PATH)) {
  console.log(`SKIP: no minsky config at ${CONFIG_PATH} — cannot boot a real MCP server here.`);
  process.exit(0);
}

const targetTask = process.argv[2] ?? "mt#2696";
const PROGRESS_TOKEN = "mt2677-probe";
const TIMEOUT_SECONDS = 20;
const INTERVAL_SECONDS = 5;
// Forces every existing review to be rejected by the `since` filter so the
// wait actually polls (and emits progress) instead of matching on poll 1.
const SINCE_FAR_FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
// Overall script safety bound: server boot + handshake + the wait's own
// TIMEOUT_SECONDS + slack for process teardown.
const SCRIPT_DEADLINE_MS = (TIMEOUT_SECONDS + 30) * 1000;

type JsonRpcMessage = Record<string, unknown>;

console.log(`[probe] Spawning session MCP server (bun run src/cli.ts mcp start)...`);

const child = Bun.spawn({
  cmd: ["bun", "run", "src/cli.ts", "mcp", "start"],
  cwd: process.cwd(),
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const stdinWriter = child.stdin;
let buffer = "";
const progressFrames: JsonRpcMessage[] = [];
let resolveResult: ((msg: JsonRpcMessage) => void) | undefined;
let resolveInit: ((msg: JsonRpcMessage) => void) | undefined;

function send(msg: JsonRpcMessage): void {
  stdinWriter.write(`${JSON.stringify(msg)}\n`);
}

async function pumpStdout(): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        // Non-JSON stdout noise (should not happen on a clean stdio server,
        // but don't let a stray line crash the probe).
        continue;
      }
      if (msg.method === "notifications/progress") {
        progressFrames.push(msg);
        const params = msg.params as { progress?: number; message?: string } | undefined;
        console.log(
          `[probe] notifications/progress #${params?.progress ?? "?"}: ${params?.message ?? ""}`
        );
      } else if (msg.id === 0 && resolveInit) {
        resolveInit(msg);
      } else if (msg.id === 1 && resolveResult) {
        resolveResult(msg);
      }
    }
  }
}
void pumpStdout();

(async function stderrTap(): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of child.stderr) {
    const text = decoder.decode(chunk, { stream: true }).trim();
    if (text) console.error(`[server-stderr] ${text}`);
  }
})();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function main(): Promise<number> {
  // 1. initialize handshake
  const initPromise = new Promise<JsonRpcMessage>((resolve) => {
    resolveInit = resolve;
  });
  send({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mt2677-progress-probe", version: "1.0.0" },
    },
  });
  const initResult = await withTimeout(initPromise, 15_000, "initialize handshake");
  console.log(`[probe] Server initialized: ${JSON.stringify(initResult.result).slice(0, 200)}`);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 2. tools/call session.pr.wait-for-review with a progressToken
  const resultPromise = new Promise<JsonRpcMessage>((resolve) => {
    resolveResult = resolve;
  });
  console.log(
    `[probe] Calling session.pr.wait-for-review(task: "${targetTask}", timeoutSeconds: ${TIMEOUT_SECONDS}) ` +
      `with _meta.progressToken="${PROGRESS_TOKEN}"...`
  );
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "session.pr.wait-for-review",
      arguments: {
        task: targetTask,
        timeoutSeconds: TIMEOUT_SECONDS,
        intervalSeconds: INTERVAL_SECONDS,
        since: SINCE_FAR_FUTURE,
        json: true,
      },
      _meta: { progressToken: PROGRESS_TOKEN },
    },
  });

  const toolResult = await withTimeout(resultPromise, SCRIPT_DEADLINE_MS, "tools/call");
  console.log(`[probe] Terminal tool response: ${JSON.stringify(toolResult.result).slice(0, 400)}`);
  console.log(`[probe] Progress frames observed: ${progressFrames.length}`);

  return progressFrames.length > 0 ? 0 : 2;
}

let exitCode: number;
try {
  exitCode = await main();
} catch (err) {
  console.error(`[probe] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  child.kill();
}

console.log(
  exitCode === 0
    ? "[probe] PASS — live notifications/progress frames observed over a real MCP stdio transport."
    : "[probe] FAIL — see above."
);
process.exit(exitCode);
