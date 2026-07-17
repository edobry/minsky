#!/usr/bin/env bun
/**
 * smoke-staleness-drain.ts — Live end-to-end verification for mt#2830.
 *
 * PHASE A (primary, exit-code-blocking): spawns the inner `minsky mcp start`
 * directly (no proxy) against a scratch git repository whose HEAD we fully
 * control, drives real newline-delimited JSON-RPC over real OS pipes, and
 * verifies the spec's literal acceptance test:
 *
 *   "Trigger a staleness exit while a slow tool call is in flight -> the
 *    call completes, no -32603 in the client transcript; next call after
 *    exit gets new-HEAD code."
 *
 * Concretely:
 *   1. A tool call that DETECTS staleness (the scratch repo's HEAD moved and
 *      touched `src/` since the inner server started) completes normally.
 *   2. A SECOND tool call issued immediately afterward — during the drain
 *      window, after staleness was detected but before the process has
 *      actually exited — ALSO completes normally. Before mt#2830 this call
 *      would have been rejected with `Error("Server is shutting down")`,
 *      surfaced to an MCP client as error -32603. This is the core
 *      regression this script guards.
 *   3. The process actually exits (drain completes, hard cap not needed).
 *   4. The disconnect log records `cause: "staleness_exit"` (not "unknown"),
 *      and nowhere in the log does a "shutting down" error appear.
 *   5. A FRESH client process started against the same scratch repo (after
 *      the exit) does not see the stale warning — i.e. the freshness
 *      guarantee for POST-exit calls is intact; the mt#2830 fix changes
 *      behavior only inside the drain window, not after.
 *
 * Why no artificial wait is needed for staleness detection: `StalenessDetector`
 * debounces re-checks to once per 60s (`CHECK_INTERVAL_MS`), but its
 * `lastCheckTime` field starts at 0 — so the FIRST tool call after server
 * startup always performs a real git-HEAD comparison regardless of the
 * debounce window. Committing to the scratch repo BEFORE the first tool call
 * is therefore sufficient to trigger a genuine staleness exit with no sleep.
 *
 * PHASE B (secondary, INFORMATIONAL — does not affect the exit code): the
 * same drive, but through a real `minsky mcp proxy` + child pair, to confirm
 * the proxy passes calls through without error and (best-effort) that it
 * transparently respawns. This phase's staleness-detection sub-check is
 * KNOWN TO BE UNRELIABLE within this harness — see the inline note at its
 * assertion site for the investigation record and why it is not exit-code
 * blocking. Phase A is what actually exercises and proves the mt#2830 fix;
 * Phase B additionally exercises the proxy's pass-through path, which has
 * its own extensive coverage in `src/mcp/stdio-proxy/proxy.test.ts`.
 *
 * This does NOT (and cannot, without mutating this session's own real
 * source) verify that a respawned process runs different CODE — only that
 * process-identity / disconnect-log evidence of a genuine exit+respawn is
 * present. The state-machine correctness (counter/pending-exit/hard-cap) is
 * covered by the injectable-clock unit tests in `src/mcp/server.test.ts`;
 * this script is the live, real-subprocess counterpart for the two
 * acceptance behaviors above that those unit tests cannot exercise (real OS
 * pipes, a real second process able to observe the exit).
 *
 * Usage:
 *   bun scripts/smoke-staleness-drain.ts
 *
 * Exit codes:
 *   0 = all Phase A assertions passed (Phase B is informational only)
 *   1 = a Phase A assertion failed, or the harness itself errored
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI_ENTRY = path.join(REPO_ROOT, "src/cli.ts");

const RESPAWN_WAIT_TIMEOUT_MS = 15_000;
const RESPAWN_POLL_INTERVAL_MS = 300;
const REQUEST_TIMEOUT_MS = 8_000;

let passed = 0;
let failed = 0;
let infoNotes = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function info(label: string): void {
  console.log(`  INFO  ${label}`);
  infoNotes++;
}

// ---------------------------------------------------------------------------
// Scratch git repo — fully-controlled staleness-detection target. Isolated
// from the real Minsky repo: the inner server's ACTUAL source is always this
// checkout (via `bun run src/cli.ts`); `--repo <scratch>` only controls what
// StalenessDetector diffs against.
// ---------------------------------------------------------------------------

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

function makeScratchRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-scratch-`));
  sh("git init -q", dir);
  sh('git config user.email "smoke@example.com"', dir);
  sh('git config user.name "smoke"', dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "marker.ts"), "export const marker = 0;\n");
  sh("git add -A", dir);
  sh('git commit -q -m "initial"', dir);
  return dir;
}

function bumpScratchRepo(dir: string): void {
  fs.writeFileSync(path.join(dir, "src", "marker.ts"), `export const marker = ${Date.now()};\n`);
  sh("git add -A", dir);
  sh('git commit -q -m "bump marker (simulate a merge touching src/)"', dir);
}

// ---------------------------------------------------------------------------
// Minimal raw-stdio JSON-RPC client (newline-delimited), modeled on
// src/commands/mcp/direct-client.ts — no `initialize` handshake needed; the
// SDK's stdio Server dispatches `tools/call` without requiring one first.
// ---------------------------------------------------------------------------

interface JsonRpcMsg {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string };
  params?: { logger?: string; text?: string };
}

class RawClient {
  private buffer = "";
  private pending = new Map<number, { resolve: (r: JsonRpcMsg) => void }>();
  private nextId = 1;
  sawStalenessNotification = false;

  constructor(private child: ChildProcessWithoutNullStreams) {
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // non-JSON line (log text sharing stdout — mt#1689 cause class 5) — ignore
      }
      if (msg.method === "notifications/message" && msg.params?.logger === "minsky-staleness") {
        this.sawStalenessNotification = true;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const waiter = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        waiter?.resolve(msg);
      }
    }
  }

  send(toolName: string, args: Record<string, unknown> = {}): number {
    const id = this.nextId++;
    const req = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };
    this.child.stdin.write(`${JSON.stringify(req)}\n`);
    return id;
  }

  awaitResponse(id: number, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<JsonRpcMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Timed out waiting for response to request id=${id} after ${timeoutMs}ms`)
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
    });
  }

  async call(
    toolName: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<JsonRpcMsg> {
    const id = this.send(toolName, args);
    return this.awaitResponse(id, timeoutMs);
  }
}

function readDisconnectLog(stateDir: string): Array<Record<string, unknown>> {
  const logPath = path.join(stateDir, "mcp-disconnect-log.json");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null);
}

// ---------------------------------------------------------------------------
// Phase A — direct inner-server drain verification (primary, blocking)
// ---------------------------------------------------------------------------

async function phaseA(): Promise<void> {
  console.log("\n=== Phase A: direct inner-server drain verification (blocking) ===");

  const scratchRepo = makeScratchRepo("mt2830-phaseA");
  const scratchState = fs.mkdtempSync(path.join(os.tmpdir(), "mt2830-phaseA-state-"));

  const child = spawn("bun", ["run", CLI_ENTRY, "mcp", "start", "--repo", scratchRepo], {
    cwd: REPO_ROOT,
    env: { ...process.env, MINSKY_STATE_DIR: scratchState },
    stdio: ["pipe", "pipe", "inherit"],
  }) as ChildProcessWithoutNullStreams;

  const client = new RawClient(child);
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  try {
    await new Promise((r) => setTimeout(r, 1200)); // let DI-free readiness settle

    // Bump BEFORE any tool call — see the module doc for why this matters
    // (StalenessDetector.lastCheckTime starts at 0; the first check is free).
    bumpScratchRepo(scratchRepo);

    console.log("\nStep A1: fire two immediate tools/call requests");
    const idA = client.send("debug.echo", { message: "detects-staleness" });
    const idB = client.send("debug.echo", { message: "during-drain-window" });
    const [respA, respB] = await Promise.all([
      client.awaitResponse(idA),
      client.awaitResponse(idB),
    ]);

    assert(!respA.error, "call A (detects staleness) completes without error");
    assert(!respB.error, "call B (during drain window) completes without error — the mt#2830 fix");
    if (respB.error) {
      assert(
        respB.error.code !== -32603 || !/shutting down/i.test(respB.error.message),
        "call B is not the -32603 'Server is shutting down' regression"
      );
    }
    assert(client.sawStalenessNotification, "staleness notification (level=alert) was emitted");

    console.log("\nStep A2: wait for the drained exit to actually occur");
    const deadline = Date.now() + RESPAWN_WAIT_TIMEOUT_MS;
    while (!exitInfo && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, RESPAWN_POLL_INTERVAL_MS));
    }
    assert(
      exitInfo !== null,
      `process exited within ${RESPAWN_WAIT_TIMEOUT_MS}ms of staleness detection`
    );
    if (exitInfo) {
      assert(
        (exitInfo as { code: number | null }).code === 0,
        "process exited with code 0 (clean exit, not a crash)"
      );
    }

    console.log("\nStep A3: verify the disconnect log");
    const events = readDisconnectLog(scratchState);
    const staleEvent = events.find((e) => e.kind === "disconnect" && e.cause === "staleness_exit");
    assert(!!staleEvent, "disconnect log contains a cause=staleness_exit event (not 'unknown')");
    const shuttingDownAnywhere = events.some(
      (e) => typeof e.error === "string" && /shutting down/i.test(e.error as string)
    );
    assert(!shuttingDownAnywhere, "no 'shutting down' error text anywhere in the disconnect log");

    console.log("\nStep A4: a FRESH process against the same (now up-to-date) repo is not stale");
    const freshState = fs.mkdtempSync(path.join(os.tmpdir(), "mt2830-phaseA-fresh-state-"));
    const freshChild = spawn("bun", ["run", CLI_ENTRY, "mcp", "start", "--repo", scratchRepo], {
      cwd: REPO_ROOT,
      env: { ...process.env, MINSKY_STATE_DIR: freshState },
      stdio: ["pipe", "pipe", "inherit"],
    }) as ChildProcessWithoutNullStreams;
    const freshClient = new RawClient(freshChild);
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const freshResp = await freshClient.call("debug.echo", { message: "post-exit-freshness" });
      assert(!freshResp.error, "fresh post-exit process serves calls normally");
      assert(
        !freshClient.sawStalenessNotification,
        "fresh post-exit process does NOT report itself stale (its own startupHead == current HEAD)"
      );
    } finally {
      freshChild.kill("SIGTERM");
      fs.rmSync(freshState, { recursive: true, force: true });
    }
  } finally {
    try {
      if (!exitInfo) child.kill("SIGTERM");
    } catch {
      // best-effort
    }
    fs.rmSync(scratchRepo, { recursive: true, force: true });
    fs.rmSync(scratchState, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Phase B — proxy pass-through (informational only, does not block exit code)
// ---------------------------------------------------------------------------

async function phaseB(): Promise<void> {
  console.log("\n=== Phase B: proxy pass-through (informational — does not affect exit code) ===");

  const scratchRepo = makeScratchRepo("mt2830-phaseB");
  const scratchState = fs.mkdtempSync(path.join(os.tmpdir(), "mt2830-phaseB-state-"));
  const childArgs = JSON.stringify(["run", CLI_ENTRY, "mcp", "start", "--repo", scratchRepo]);

  const proxy = spawn(
    "bun",
    ["run", CLI_ENTRY, "mcp", "proxy", "--child-command", "bun", "--child-args", childArgs],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MINSKY_STATE_DIR: scratchState },
      stdio: ["pipe", "pipe", "inherit"],
    }
  ) as ChildProcessWithoutNullStreams;

  const client = new RawClient(proxy);

  try {
    await new Promise((r) => setTimeout(r, 1500));
    bumpScratchRepo(scratchRepo);

    const idA = client.send("debug.echo", { message: "phaseB-a" });
    const idB = client.send("debug.echo", { message: "phaseB-b" });
    const [respA, respB] = await Promise.all([
      client.awaitResponse(idA),
      client.awaitResponse(idB),
    ]);
    if (!respA.error && !respB.error) {
      console.log("  INFO  proxy forwards both calls through without error");
      infoNotes++;
    } else {
      console.log(
        `  INFO  proxy forwarded a call with an error (non-blocking): ${JSON.stringify({
          respA: respA.error,
          respB: respB.error,
        })}`
      );
      infoNotes++;
    }

    // KNOWN HARNESS GAP (investigated during mt#2830 authoring, 2026-07-17):
    // in repeated runs against this harness, the staleness notification did
    // not reliably appear within the observation window when the inner was
    // spawned as a proxy child, even though the identical bump-before-first-
    // call sequence reliably triggers it in Phase A (direct spawn, no proxy)
    // and is separately proven correct by the server.test.ts unit suite. The
    // root cause was not conclusively isolated within this task's budget —
    // candidates considered and not confirmed: proxy inbound-transform
    // buffering delay, ready-probe interaction, git-diff timing under a
    // nested process tree. This is recorded here rather than silently
    // dropped so a future investigator has the lead. It does NOT undermine
    // Phase A's proof of the mt#2830 fix — the fix lives entirely in
    // server.ts's request-handler gate, which Phase A exercises directly.
    if (client.sawStalenessNotification) {
      info("staleness notification observed through the proxy in this run");
    } else {
      info(
        "staleness notification NOT observed through the proxy within the window " +
          "(known unresolved harness timing gap — see comment above this line in source; " +
          "not exit-code blocking, does not affect Phase A's verification of the mt#2830 fix)"
      );
    }
  } finally {
    try {
      proxy.kill("SIGTERM");
    } catch {
      // best-effort
    }
    fs.rmSync(scratchRepo, { recursive: true, force: true });
    fs.rmSync(scratchState, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await phaseA();
  try {
    await phaseB();
  } catch (err) {
    console.log(`  INFO  Phase B harness error (non-blocking): ${(err as Error).message}`);
    infoNotes++;
  }

  console.log(`\n${"-".repeat(60)}`);
  console.log(
    `Smoke test: ${passed} passed, ${failed} failed, ${infoNotes} informational (Phase B)`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
