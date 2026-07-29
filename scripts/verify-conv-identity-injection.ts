#!/usr/bin/env bun
/**
 * E2E verification artifact for conversation-identity injection
 * (mt#3285, ADR-006 Phase 2) — the §7a structural-change smoke script.
 *
 * Spawns the REAL `minsky mcp proxy` (via src/cli.ts) with a synthetic
 * CLAUDE_CODE_SESSION_ID, pointing its child at THIS script in recorder mode.
 * The recorder captures every JSON-RPC line the inner server would receive
 * and answers the proxy's readiness ping. The script then asserts, on the
 * actual forwarded bytes:
 *
 *   1. active:    tools/call arrives with _meta["io.minsky/agent_id"] ===
 *                 com.anthropic.claude-code:conv:<uuid>; initialize is untouched.
 *   2. hookless:  env var absent → tools/call forwarded byte-identical,
 *                 no _meta key (spec AT3 fall-through).
 *   3. malformed: env var not a UUID → same as hookless (spec AT4).
 *
 * Requires no external env vars, credentials, or network — fully hermetic.
 * Exit 0 = all cases pass; non-zero = failure, JSON summary on stdout.
 *
 * Usage: bun scripts/verify-conv-identity-injection.ts
 */

import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createInterface } from "readline";

const AGENT_ID_META_KEY = "io.minsky/agent_id";
const TEST_UUID = "e2e0f1d2-3c4b-4a5d-9e8f-0123456789ab";
const EXPECTED_AGENT_ID = `com.anthropic.claude-code:conv:${TEST_UUID}`;

// ---------------------------------------------------------------------------
// Recorder mode: child process standing in for the inner MCP server.
// Appends every stdin line to the capture file; answers ping (the proxy's
// readiness probe) so start() resolves without waiting for the 2s timeout.
// ---------------------------------------------------------------------------
if (process.argv[2] === "--recorder") {
  const captureFile = process.argv[3];
  if (!captureFile) {
    process.stderr.write("recorder: missing capture file arg\n");
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    appendFileSync(captureFile, `${line}\n`);
    try {
      const msg = JSON.parse(line) as { id?: unknown; method?: string };
      if (msg.method === "ping" && msg.id !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
      }
    } catch {
      // Non-JSON line — captured above, nothing to answer.
    }
  });
  rl.on("close", () => process.exit(0));
} else {
  await main();
}

interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface CapturedFrame {
  method?: string;
  params?: { _meta?: Record<string, unknown>; [key: string]: unknown };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCase(opts: {
  name: string;
  sessionIdEnv: string | undefined;
  assert: (toolsCall: CapturedFrame, initialize: CapturedFrame) => string | null;
}): Promise<CaseResult> {
  const captureDir = mkdtempSync(join(tmpdir(), "conv-identity-verify-"));
  const captureFile = join(captureDir, "capture.jsonl");
  const scriptPath = resolve(import.meta.dir, "verify-conv-identity-injection.ts");
  const cliPath = resolve(import.meta.dir, "..", "src", "cli.ts");

  const env: Record<string, string | undefined> = { ...process.env };
  delete env["CLAUDE_CODE_SESSION_ID"];
  if (opts.sessionIdEnv !== undefined) env["CLAUDE_CODE_SESSION_ID"] = opts.sessionIdEnv;

  let proxy: ChildProcess | null = null;
  try {
    proxy = spawn(
      "bun",
      [
        cliPath,
        "mcp",
        "proxy",
        "--child-command",
        "bun",
        "--child-args",
        JSON.stringify([scriptPath, "--recorder", captureFile]),
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] }
    );

    const initializeFrame = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify" } },
    };
    const toolsCallFrame = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tasks_get", arguments: { taskId: "mt#3285" } },
    };
    if (!proxy.stdin) {
      return { name: opts.name, pass: false, detail: "proxy spawned without a stdin pipe" };
    }
    proxy.stdin.write(`${JSON.stringify(initializeFrame)}\n${JSON.stringify(toolsCallFrame)}\n`);

    // Wait for the recorder to have captured the tools/call (the proxy's own
    // ping probe may land first; poll on content, not line count).
    const deadline = Date.now() + 20_000;
    let frames: CapturedFrame[] = [];
    while (Date.now() < deadline) {
      if (existsSync(captureFile)) {
        try {
          frames = readFileSync(captureFile, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as CapturedFrame);
        } catch {
          // A line may be mid-append; poll again.
          frames = [];
        }
        if (frames.some((f) => f.method === "tools/call")) break;
      }
      await sleep(200);
    }

    const toolsCall = frames.find((f) => f.method === "tools/call");
    const initialize = frames.find((f) => f.method === "initialize");
    if (!toolsCall || !initialize) {
      return {
        name: opts.name,
        pass: false,
        detail: `timed out waiting for frames (captured methods: ${frames.map((f) => f.method).join(", ") || "none"})`,
      };
    }

    const failure = opts.assert(toolsCall, initialize);
    return { name: opts.name, pass: failure === null, detail: failure ?? "ok" };
  } finally {
    if (proxy && proxy.pid) proxy.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];

  results.push(
    await runCase({
      name: "active: UUID env stamps conv-scoped agent_id into tools/call",
      sessionIdEnv: TEST_UUID,
      assert: (toolsCall, initialize) => {
        const meta = toolsCall.params?._meta;
        if (!meta || meta[AGENT_ID_META_KEY] !== EXPECTED_AGENT_ID) {
          return `expected _meta[${AGENT_ID_META_KEY}] === ${EXPECTED_AGENT_ID}, got: ${JSON.stringify(meta)}`;
        }
        if ((toolsCall.params as Record<string, unknown>)["name"] !== "tasks_get") {
          return "tool name corrupted in forwarded frame";
        }
        if (initialize.params && "_meta" in initialize.params) {
          return "initialize frame must not be stamped";
        }
        return null;
      },
    })
  );

  results.push(
    await runCase({
      name: "hookless: absent env forwards tools/call without _meta (AT3)",
      sessionIdEnv: undefined,
      assert: (toolsCall) =>
        toolsCall.params && "_meta" in toolsCall.params
          ? `unexpected _meta present: ${JSON.stringify(toolsCall.params["_meta"])}`
          : null,
    })
  );

  results.push(
    await runCase({
      name: "malformed: non-UUID env falls through to Layer 1 (AT4)",
      sessionIdEnv: "not-a-uuid",
      assert: (toolsCall) =>
        toolsCall.params && "_meta" in toolsCall.params
          ? `unexpected _meta present: ${JSON.stringify(toolsCall.params["_meta"])}`
          : null,
    })
  );

  const pass = results.every((r) => r.pass);
  process.stdout.write(
    `${JSON.stringify({ pass, expectedAgentId: EXPECTED_AGENT_ID, results }, null, 2)}\n`
  );
  process.exit(pass ? 0 : 1);
}
