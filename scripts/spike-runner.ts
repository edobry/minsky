// THROWAWAY SPIKE RUNNER for mt#1315 — drives spike-mcp-signals.ts via raw JSON-RPC.
// Captures server stdout, sidecar log, and exit behavior. Output as a single JSON
// document the agent can read and turn into findings.

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

const LOG_PATH = "/tmp/spike-mcp-signals.log";

type Frame = { ts: number; kind: "stdout" | "stderr" | "event"; line: string };
const frames: Frame[] = [];
const t0 = Date.now();
function record(kind: Frame["kind"], line: string): void {
  frames.push({ ts: Date.now() - t0, kind, line });
}

// Truncate sidecar log so this run is observable in isolation.
try {
  fs.writeFileSync(LOG_PATH, "");
} catch {
  // Sidecar log is best-effort; continue if we can't truncate.
}

const SCRIPT = path.resolve(import.meta.dir, "spike-mcp-signals.ts");
const child = spawn("bun", ["run", SCRIPT, "--transport=stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = "";
child.stdout.on("data", (chunk: Buffer) => {
  stdoutBuf += chunk.toString();
  let nl: number;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (line.trim()) record("stdout", line);
  }
});
child.stderr.on("data", (chunk: Buffer) => {
  for (const line of chunk.toString().split("\n")) {
    if (line.trim()) record("stderr", line);
  }
});

let exitCode: number | null = null;
let exitSignal: NodeJS.Signals | null = null;
const exited = new Promise<void>((resolve) => {
  child.on("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    record("event", `child exited code=${code} signal=${signal}`);
    resolve();
  });
});

function send(obj: unknown): void {
  const line = JSON.stringify(obj);
  record("event", `→ ${line}`);
  child.stdin.write(`${line}\n`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(): Promise<void> {
  await sleep(150);

  // 1. initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "spike-runner", version: "1.0" },
    },
  });
  await sleep(200);

  // 2. initialized notification
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await sleep(100);

  // 3. tools/list (sanity)
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await sleep(150);

  // 4. logging/setLevel to debug (most permissive)
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "logging/setLevel",
    params: { level: "debug" },
  });
  await sleep(150);

  // 5. emit_log at every severity
  const levels = [
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency",
  ] as const;
  let id = 10;
  for (const level of levels) {
    send({
      jsonrpc: "2.0",
      id: id++,
      method: "tools/call",
      params: {
        name: "emit_log",
        arguments: { level, text: `spike test ${level}` },
      },
    });
    await sleep(80);
  }

  // 6. echo (verifies normal tool flow still works after logs)
  send({
    jsonrpc: "2.0",
    id: id++,
    method: "tools/call",
    params: { name: "echo", arguments: { message: "post-log echo" } },
  });
  await sleep(120);

  // 7. logging/setLevel raised to error → emit_log at info should be filtered
  send({
    jsonrpc: "2.0",
    id: id++,
    method: "logging/setLevel",
    params: { level: "error" },
  });
  await sleep(80);
  send({
    jsonrpc: "2.0",
    id: id++,
    method: "tools/call",
    params: {
      name: "emit_log",
      arguments: { level: "info", text: "should be filtered" },
    },
  });
  await sleep(80);
  send({
    jsonrpc: "2.0",
    id: id++,
    method: "tools/call",
    params: {
      name: "emit_log",
      arguments: { level: "error", text: "should pass" },
    },
  });
  await sleep(120);

  // 8. exit_server with short delay → server must close stdio cleanly
  send({
    jsonrpc: "2.0",
    id: id++,
    method: "tools/call",
    params: { name: "exit_server", arguments: { delayMs: 100 } },
  });
  // Wait for actual exit (or timeout safety)
  const timeout = new Promise<void>((r) => setTimeout(r, 3000));
  await Promise.race([exited, timeout]);
  await sleep(50);
}

await run();

// Read sidecar log
let sidecar = "";
try {
  sidecar = fs.readFileSync(LOG_PATH, "utf-8");
} catch (err) {
  sidecar = `<failed to read ${LOG_PATH}: ${err}>`;
}

const result = {
  exit: { code: exitCode, signal: exitSignal },
  totalFrames: frames.length,
  frames,
  sidecarLines: sidecar.split("\n").filter((l) => l.trim()).length,
  sidecarSample: sidecar
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 80),
};

console.log(JSON.stringify(result, null, 2));
process.exit(0);
