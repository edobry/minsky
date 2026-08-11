#!/usr/bin/env bun
/**
 * Live verification for the local shared MCP daemon (mt#3814, ADR-038).
 *
 * Drives a REAL `minsky mcp start --local-daemon` process and asserts the
 * lifecycle behaviors the unit tests cannot reach: that the bind actually
 * adopts an incumbent, that it actually refuses an unrelated listener, that
 * the token file lands at 0600 on a real filesystem, that auth is actually
 * enforced over HTTP, and that a session is actually reaped.
 *
 * Isolation: every run points `MINSKY_STATE_DIR` and
 * `MINSKY_LOCAL_MCP_TOKEN_PATH` at a fresh temp directory and binds a
 * caller-supplied port on 127.0.0.1, so it never touches the operator's real
 * daemon state or competes with a running daemon for the ADR-038 port.
 *
 * Usage:
 *   bun scripts/verify-local-mcp-daemon.ts [--port 48891] [--json]
 *
 * Exit code is 0 only when every check passes.
 */

import { spawn, type ChildProcess } from "child_process";
import { execSync } from "child_process";
import { mkdtempSync, statSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";

interface CheckResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];
const spawned: ChildProcess[] = [];

function record(id: string, name: string, passed: boolean, detail: string): void {
  results.push({ id, name, passed, detail });
  const mark = passed ? "PASS" : "FAIL";
  process.stdout.write(`[${mark}] ${id} ${name}\n       ${detail}\n`);
}

function parseArgs(argv: string[]): { port: number; json: boolean } {
  let port = 48891;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) port = Number.parseInt(argv[++i] as string, 10);
    else if (argv[i] === "--json") json = true;
  }
  return { port, json };
}

function makeIsolatedEnv(stateDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MINSKY_STATE_DIR: stateDir,
    MINSKY_LOCAL_MCP_TOKEN_PATH: join(stateDir, "local-mcp-token"),
    ...extra,
  };
}

function spawnDaemon(port: number, env: NodeJS.ProcessEnv, extraArgs: string[] = []): ChildProcess {
  const child = spawn(
    "bun",
    ["run", "src/cli.ts", "mcp", "start", "--local-daemon", "--port", String(port), ...extraArgs],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
  spawned.push(child);
  return child;
}

/** Collect a child's stdout+stderr and resolve with its exit code. */
function collect(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    child.stdout?.on("data", (c) => (output += String(c)));
    child.stderr?.on("data", (c) => (output += String(c)));
    child.on("exit", (code) => resolve({ code, output }));
  });
}

async function waitForHealth(
  port: number,
  timeoutMs = 60_000
): Promise<{ ok: boolean; body: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return { ok: true, body: await response.json() };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { ok: false, body: null };
}

/**
 * Whether `lsof` is present and runnable.
 *
 * Deliberately distinct from "lsof found no listeners": both produce an empty
 * result from `listenerPids`, and only one of them means the assertions built
 * on it carry information.
 */
function lsofIsAvailable(): boolean {
  try {
    execSync("command -v lsof", { timeout: 5000, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function listenerPids(port: number): number[] {
  try {
    const out = String(
      execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
    ).trim();
    if (!out) return [];
    return out
      .split(/\s+/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

async function postInitialize(
  port: number,
  token: string | null
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "verify-local-mcp-daemon", version: "1" },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.text() };
}

async function main(): Promise<void> {
  const { port, json } = parseArgs(process.argv.slice(2));
  const stateDir = mkdtempSync(join(tmpdir(), "minsky-daemon-verify-"));
  process.stdout.write(
    `Verifying the local MCP daemon on 127.0.0.1:${port}\nState dir: ${stateDir}\n\n`
  );

  // PR #2871 R1 NON-BLOCKING: three checks below assert on listener counts, and
  // `listenerPids` returns [] when `lsof` is unavailable. For the two
  // "exactly one listener" assertions that yields a visible FAIL, which is
  // fine — but the teardown check asserts ZERO listeners, so a missing `lsof`
  // would make it pass vacuously and report a clean run that verified nothing.
  // Establish the tool works before trusting any count derived from it.
  if (!lsofIsAvailable()) {
    process.stdout.write(
      "SKIP: `lsof` is unavailable, so listener-count assertions cannot be trusted " +
        "(the teardown check would pass vacuously). Install lsof or run on a host that has it.\n"
    );
    process.exit(0);
  }

  if (listenerPids(port).length > 0) {
    process.stdout.write(`SKIP: port ${port} is already in use — pass --port <free port>\n`);
    process.exit(0);
  }

  const env = makeIsolatedEnv(stateDir);

  // ---- AT1: health identity, not merely a 200 ---------------------------
  const daemon = spawnDaemon(port, env);
  // Drain the daemon's pipes so a chatty boot cannot fill the buffer and stall
  // the process; the output itself is not asserted for this check.
  void collect(daemon);
  const health = await waitForHealth(port);
  const healthService = (health.body as { service?: string } | null)?.service;
  record(
    "AT1",
    "daemon answers /health with the asserted minsky-mcp identity",
    health.ok && healthService === "minsky-mcp",
    `reachable=${health.ok} service=${String(healthService)}`
  );

  // ---- AT4: token file mode ---------------------------------------------
  const tokenPath = join(stateDir, "local-mcp-token");
  const tokenExists = existsSync(tokenPath);
  const tokenMode = tokenExists ? (statSync(tokenPath).mode & 0o777).toString(8) : "absent";
  record(
    "AT4",
    "the daemon generated its bearer token at mode 0600",
    tokenMode === "600",
    `path=${tokenPath} mode=${tokenMode}`
  );
  const token = tokenExists ? readFileSync(tokenPath, "utf8").trim() : null;

  // ---- discovery file ----------------------------------------------------
  const discoveryPath = join(stateDir, "local-mcp.json");
  let discoveryOk = false;
  let discoveryDetail = "absent";
  if (existsSync(discoveryPath)) {
    const parsed = JSON.parse(readFileSync(discoveryPath, "utf8")) as Record<string, unknown>;
    discoveryOk = parsed["port"] === port && parsed["pid"] === daemon.pid;
    discoveryDetail = `port=${String(parsed["port"])} pid=${String(parsed["pid"])} (daemon pid=${daemon.pid})`;
  }
  record(
    "SC6",
    "discovery file reflects the actual bound port and pid",
    discoveryOk,
    discoveryDetail
  );

  // ---- AT5: auth is enforced --------------------------------------------
  const unauthed = await postInitialize(port, null);
  const authed = await postInitialize(port, token);
  record(
    "AT5",
    "initialize is rejected without the token and accepted with it",
    unauthed.status === 401 && authed.status >= 200 && authed.status < 300,
    `without=${unauthed.status} with=${authed.status}`
  );

  // ---- AT2: a second daemon adopts rather than competing ------------------
  const second = spawnDaemon(port, env);
  const secondResult = await collect(second);
  const pidsAfterSecond = listenerPids(port);
  record(
    "AT2",
    "a second daemon on the same port adopts the incumbent and leaves one listener",
    secondResult.code === 0 &&
      secondResult.output.includes("Adopting the incumbent") &&
      pidsAfterSecond.length === 1,
    `exit=${String(secondResult.code)} listeners=${pidsAfterSecond.length}`
  );

  // ---- AT8: session-admission watermark ----------------------------------
  // A 1MB watermark is below any live process's RSS, so the gate refuses every
  // NEW session. The control is AT5's accepted initialize on the same build
  // with the default watermark: the same request, admitted. Without that pair
  // a refusal here would be indistinguishable from a daemon that rejects
  // everything.
  const watermarkPort = port + 1;
  const watermarkState = mkdtempSync(join(tmpdir(), "minsky-daemon-verify-wm-"));
  const watermarkDaemon = spawnDaemon(
    watermarkPort,
    makeIsolatedEnv(watermarkState, { MINSKY_MCP_SESSION_ADMISSION_WATERMARK_MB: "1" })
  );
  void collect(watermarkDaemon);
  const watermarkHealth = await waitForHealth(watermarkPort);
  let watermarkOk = false;
  let watermarkDetail = "daemon did not become healthy";
  if (watermarkHealth.ok) {
    const wmToken = readFileSync(join(watermarkState, "local-mcp-token"), "utf8").trim();
    const refused = await postInitialize(watermarkPort, wmToken);
    watermarkOk = refused.status === 503 && refused.body.includes("session-admission watermark");
    watermarkDetail = `status=${refused.status} body=${refused.body.slice(0, 160)}`;
  }
  record(
    "AT8",
    "above the watermark a NEW session is refused 503 (control: AT5 admitted the same request)",
    watermarkOk,
    watermarkDetail
  );

  // ---- AT3: an unrelated listener is a loud failure, not an adopt ---------
  const foreignPort = port + 2;
  const foreign = createServer(() => {});
  await new Promise<void>((resolve) => foreign.listen(foreignPort, "127.0.0.1", resolve));
  const conflicted = spawnDaemon(foreignPort, makeIsolatedEnv(stateDir));
  const conflictResult = await collect(conflicted);
  const foreignListeners = listenerPids(foreignPort);
  record(
    "AT3",
    "a non-Minsky listener causes a loud failure naming the port, and no listener elsewhere",
    conflictResult.code === 1 &&
      conflictResult.output.includes(`127.0.0.1:${foreignPort}`) &&
      foreignListeners.length === 1,
    `exit=${String(conflictResult.code)} listeners-on-port=${foreignListeners.length}`
  );
  foreign.close();

  // ---- AT6: idle reaping -------------------------------------------------
  // A reaped session's id stops resolving: the next request carrying it gets
  // 404 "Session not found" rather than being served. That is the observable
  // consequence of the reap, from a client's point of view.
  const reapPort = port + 3;
  const reapState = mkdtempSync(join(tmpdir(), "minsky-daemon-verify-reap-"));
  const reapDaemon = spawnDaemon(
    reapPort,
    makeIsolatedEnv(reapState, {
      MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS: "1000",
      MINSKY_MCP_SESSION_REAPER_INTERVAL_MS: "500",
    })
  );
  void collect(reapDaemon);
  const reapHealth = await waitForHealth(reapPort);
  let reapOk = false;
  let reapDetail = "daemon did not become healthy";
  if (reapHealth.ok) {
    const reapToken = readFileSync(join(reapState, "local-mcp-token"), "utf8").trim();
    const opened = await fetch(`http://127.0.0.1:${reapPort}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${reapToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "verify-local-mcp-daemon", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const sessionId = opened.headers.get("mcp-session-id");
    if (sessionId) {
      await new Promise((r) => setTimeout(r, 6000));
      const afterReap = await fetch(`http://127.0.0.1:${reapPort}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${reapToken}`,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(15_000),
      });
      reapOk = afterReap.status === 404;
      reapDetail = `session=${sessionId.slice(0, 8)}… status-after-idle=${afterReap.status}`;
    } else {
      reapDetail = "no mcp-session-id header on initialize";
    }
  }
  record("AT6", "an idle session is reaped and its id stops resolving", reapOk, reapDetail);

  // ---- AT7: the ceiling exits through the graceful path -------------------
  // A 1MB ceiling trips on the first poll. What this checks is the EXIT ROUTE,
  // not the threshold: exit code 0 means the breach ran `cleanup` — which
  // calls `server.drain()` (new tool calls rejected, up to 5s for in-flight
  // ones, then close) and closes persistence — rather than terminating the
  // process where it stood. A hard exit would surface as a non-zero code.
  //
  // The complementary half — a call actually in flight AT the moment of the
  // breach — is not made deterministic here; mt#3973's AT1 already observed
  // the capture watcher and the self-terminate firing on the same process with
  // the exit completing 0.
  const ceilingPort = port + 4;
  const ceilingState = mkdtempSync(join(tmpdir(), "minsky-daemon-verify-ceiling-"));
  const ceilingDaemon = spawnDaemon(
    ceilingPort,
    makeIsolatedEnv(ceilingState, {
      MINSKY_MCP_MEMORY_CEILING_MB: "1",
      MINSKY_MCP_MEMORY_CEILING_POLL_MS: "250",
      MINSKY_MCP_FORCE_MEMORY_CEILING_EXIT: "1",
    })
  );
  const ceilingResult = await collect(ceilingDaemon);
  record(
    "AT7",
    "a resident-memory ceiling breach exits through the graceful cleanup path",
    ceilingResult.code === 0 && ceilingResult.output.includes("ceiling"),
    `exit=${String(ceilingResult.code)} role-logged=${ceilingResult.output.includes("local-daemon")}`
  );

  // ---- teardown ----------------------------------------------------------
  for (const child of spawned) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Already gone — the adopt and conflict paths exit on their own.
      }
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
  const leaked = [port, port + 1, port + 2, port + 3].flatMap((p) =>
    listenerPids(p).map((pid) => `${p}:${pid}`)
  );
  record(
    "teardown",
    "no listener left behind on any verification port",
    leaked.length === 0,
    leaked.join(", ") || "none"
  );

  const failures = results.filter((r) => !r.passed);
  const summary = {
    port,
    checks: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    results,
  };
  if (json) {
    writeFileSync("scripts/verify-local-mcp-daemon-results.json", JSON.stringify(summary, null, 2));
  }
  const failureSuffix = failures.length
    ? ` — FAILED: ${failures.map((f) => f.id).join(", ")}\n`
    : "\n";
  process.stdout.write(`\n${summary.passed}/${summary.checks} checks passed${failureSuffix}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main().catch((error) => {
  process.stderr.write(`verification harness error: ${String(error)}\n`);
  for (const child of spawned) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // best effort
      }
    }
  }
  process.exit(1);
});
