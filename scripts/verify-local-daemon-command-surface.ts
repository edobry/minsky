#!/usr/bin/env bun
/**
 * mt#4338 — verify the LOCAL daemon serves the full command surface.
 *
 * ## Why this script exists rather than a unit test
 *
 * `src/cli-discriminators.test.ts` asserts the predicate. That is necessary and
 * it is not sufficient: the defect this task fixes was invisible to every unit
 * test in the repo, because the guard's own tests set `setHostedMode(true)`
 * directly and asserted what the guard DOES — never how the flag gets its
 * value. A predicate test could drift out of alignment with the call site the
 * same way, so this exercises the real binding: a real daemon process, started
 * with the real `--local-daemon` argv, answering a real `git.*` MCP call.
 *
 * ## Why a `git.*` call specifically
 *
 * The flip that surfaced this bug was pre-flighted three separate times, and
 * all three probes passed while the daemon was broken. Every one of them used
 * METADATA calls (`tasks_status_get`, `refs_status`) — which are hosted-safe by
 * construction, so they return identical results whether or not the command
 * surface is amputated. A probe that cannot fail is not verification (mem#704).
 * `git.status` is on the refused list, so it discriminates.
 *
 * Run: bun scripts/verify-local-daemon-command-surface.ts
 * Exit 0 = the local daemon served git.status. Exit 1 = it refused (regression).
 */

import { spawn } from "child_process";

import { ensureLocalDaemonToken } from "../src/mcp/daemon/local-daemon";

const PORT = Number(process.env.MT4338_VERIFY_PORT ?? 48799);
const URL = `http://127.0.0.1:${PORT}/mcp`;
const REPO = process.cwd();

// ADR-038 §Question 5: the local daemon is auth-required and mints its own
// token. Reading it through the same idempotent helper the daemon itself uses
// is what makes this probe reach the guard — the first draft of this script
// omitted it, got a 401, and PASSED anyway because it only checked that a
// refusal string was ABSENT. That is the same can't-fail shape the flip's three
// pre-flights had; the positive assertion below is the actual fix.
const AUTH_TOKEN = ensureLocalDaemonToken().token;

type Json = Record<string, unknown>;

let sessionId: string | undefined;

/** One JSON-RPC round trip over MCP streamable HTTP. */
async function rpc(method: string, params: Json = {}, id?: number): Promise<Json> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${AUTH_TOKEN}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body: Json = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;

  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  const text = await res.text();
  if (!text.trim()) return {};

  // Streamable HTTP may answer as SSE; take the last `data:` frame.
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  const payload = dataLines.length > 0 ? dataLines[dataLines.length - 1] : text;
  try {
    return JSON.parse(payload as string) as Json;
  } catch {
    return { raw: text };
  }
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { ready?: boolean };
        if (body.ready === true) return true;
      }
    } catch {
      // intentional-swallow: the daemon is still booting; the deadline governs.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const child = spawn(
  "bun",
  ["run", "src/cli.ts", "mcp", "start", "--local-daemon", "--port", String(PORT), "--repo", REPO],
  { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: false }
);

let daemonLog = "";
child.stdout?.on("data", (d) => (daemonLog += d.toString()));
child.stderr?.on("data", (d) => (daemonLog += d.toString()));

function cleanup(): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // intentional-swallow: best-effort teardown; the process may already be gone.
  }
}

try {
  console.log(`[mt#4338] starting local daemon on :${PORT} (--local-daemon, --repo ${REPO})`);
  if (!(await waitForHealth(60_000))) {
    console.error("[mt#4338] FAIL: daemon never reported ready:true within 60s");
    console.error(daemonLog.slice(-2000));
    cleanup();
    process.exit(1);
  }
  console.log("[mt#4338] daemon ready");

  await rpc(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mt4338-verify", version: "1.0.0" },
    },
    1
  );
  await rpc("notifications/initialized");

  // The discriminating call: git.* is refused by guardHostedCapability when the
  // server believes it is hosted.
  const result = (await rpc("tools/call", { name: "git_status", arguments: {} }, 2)) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };

  const rendered = JSON.stringify(result);

  // Fail on the specific regression FIRST, so its message is the one reported.
  if (rendered.includes("not supported on the hosted")) {
    console.error("[mt#4338] FAIL: local daemon refused git_status as if it were hosted.");
    console.error(rendered.slice(0, 800));
    cleanup();
    process.exit(1);
  }

  // Then assert POSITIVELY that the call actually reached git and came back
  // with a real working-tree payload. Checking only for the absence of the
  // refusal string would also "pass" on a 401, a transport error, or an empty
  // body — none of which exercise the guard at all.
  // Substring checks, not a quoted-key regex: git_status's payload arrives as
  // JSON *inside* an MCP text block, so its own quotes are escaped (`\"workdir\"`)
  // and a `/"workdir"/` pattern does not match. Field NAMES are distinctive
  // enough on their own here.
  const served =
    !rendered.includes("unauthorized") &&
    result.error === undefined &&
    result.result?.isError !== true &&
    rendered.includes("workdir") &&
    rendered.includes("branch");

  if (!served) {
    console.error(
      "[mt#4338] FAIL: git_status did not return a working-tree payload — the probe " +
        "never reached the command surface, so it proves nothing either way."
    );
    console.error(rendered.slice(0, 800));
    cleanup();
    process.exit(1);
  }

  console.log("[mt#4338] PASS: local daemon served git_status with a real working-tree payload.");
  console.log(`[mt#4338] response head: ${rendered.slice(0, 300)}`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error(`[mt#4338] FAIL: verification threw: ${String(err)}`);
  console.error(daemonLog.slice(-2000));
  cleanup();
  process.exit(1);
}
