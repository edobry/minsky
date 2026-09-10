#!/usr/bin/env bun
/**
 * Live verification for the post-deploy monitor's secondary (ask) alert channel
 * (mt#4012).
 *
 * ## What this exists to catch
 *
 * The channel's correctness is a claim about the WIRE — what the MCP
 * Streamable-HTTP transport actually puts in a response body — and no unit test
 * can settle that. For the whole life of the channel there was no way to run it
 * except to wait for a production outage to run it for you, because the
 * transport lived inside `scripts/post-deploy-health-monitor.ts`, which calls
 * `main()` at module scope and can never be imported.
 *
 * When an outage finally did exercise it, every call failed with
 * `SyntaxError: Failed to parse JSON` — the server answers `tools/call` with
 * `Content-Type: text/event-stream` and the reader called `res.json()`. The
 * failure was swallowed as `non-fatal` and ran for at least eight hours during
 * a live P0 with nobody able to tell the difference between "working" and
 * "broken on every call since the day it shipped".
 *
 * This script closes that gap: it drives the SAME `withMcpSession` the monitor
 * uses, against a real server, on demand.
 *
 * ## Why it is safe to run
 *
 * **It only READS.** It calls `asks_list`, which is the first call the alert
 * path makes anyway, and never `asks_create` or `asks_cancel`. So it creates no
 * ask, retires no ask, and — importantly — sends no `severity: "incident"`
 * notification to the principal's phone. The transport is exactly the same one
 * the create path uses, so a read proves the read/parse chain end to end.
 *
 * ## Usage
 *
 *   MINSKY_MCP_AUTH_TOKEN=<token> bun scripts/verify-monitor-ask-channel.ts
 *   MINSKY_MCP_AUTH_TOKEN=<token> bun scripts/verify-monitor-ask-channel.ts --url http://127.0.0.1:48813/mcp
 *
 * Exits 0 on pass or on a documented SKIP (no token configured), 1 on failure.
 * Emits a JSON result line so CI can consume it.
 *
 * @see mt#4012 — this script and the SSE fix
 * @see mt#2782 — the channel
 * @see packages/domain/src/deployment/monitor-mcp-session.ts — the shared shell
 */

import {
  MONITOR_ALERT_ASK_KIND,
  parseOpenAsksResponse,
} from "../packages/domain/src/deployment/monitor-ask-alert";
import {
  MINSKY_MCP_URL,
  withMcpSession,
} from "../packages/domain/src/deployment/monitor-mcp-session";

interface VerifyResult {
  ok: boolean;
  url: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

function readUrlFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf("--url");
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value) throw new Error("--url requires a value");
  return value;
}

async function main(): Promise<void> {
  const authToken = process.env.MINSKY_MCP_AUTH_TOKEN;
  if (!authToken) {
    // Graceful skip, per /implement-task §7a: an artifact that cannot reach its
    // target must say so and exit 0 rather than failing a run that never had
    // the credential.
    console.log("SKIP: MINSKY_MCP_AUTH_TOKEN not set — cannot reach an MCP server.");
    process.exit(0);
  }

  // Endpoint comes from `--url` or the shared production constant. Deliberately
  // NOT a new `MINSKY_MCP_URL` env var: that name is unregistered, and the
  // env-var-to-config parser would auto-map it to `mcp.url` (mt#4223). A flag is
  // enough for a probe, and ADR-028 D3 exists to stop this population growing.
  const url = readUrlFlag(process.argv.slice(2)) ?? MINSKY_MCP_URL;
  const checks: VerifyResult["checks"] = [];

  console.log(`Verifying the monitor's ask channel against ${url}`);
  console.log("(read-only: asks_list — no ask is created, retired, or notified)\n");

  let raw: unknown;
  try {
    raw = await withMcpSession(
      { authToken, url, clientName: "verify-monitor-ask-channel" },
      (callTool) => callTool("asks_list", { kind: MONITOR_ALERT_ASK_KIND })
    );
    checks.push({
      name: "session opens and a tool call returns a readable body",
      ok: true,
      // This is the assertion that fails pre-fix: the SSE body reached
      // `res.json()` and threw before anything could look at it.
      detail: "init handshake + tools/call parsed (SSE-framed body read correctly)",
    });
  } catch (err) {
    checks.push({
      name: "session opens and a tool call returns a readable body",
      ok: false,
      detail: `${err}`,
    });
    report({ ok: false, url, checks });
    process.exit(1);
  }

  // A readable body is not yet a JSON-RPC RESULT — a JSON-RPC error also parses.
  const envelope = raw as { error?: { message?: string }; result?: unknown } | null;
  const isResult = Boolean(envelope && typeof envelope === "object" && envelope.result);
  checks.push({
    name: "the response is a JSON-RPC result, not an error",
    ok: isResult,
    detail: isResult
      ? "result member present"
      : `no result member (error: ${envelope?.error?.message ?? "none"})`,
  });

  // And a result is not yet a readable LISTING. This is the same parser the
  // alert path's coalesce decision depends on, so a shape it cannot read would
  // silently make every tick create a duplicate ask.
  const asks = parseOpenAsksResponse(raw);
  const parsedListing = Array.isArray(asks);
  checks.push({
    name: "parseOpenAsksResponse reads the listing the coalesce decision needs",
    ok: parsedListing && isResult,
    detail: `parsed ${asks.length} open ${MONITOR_ALERT_ASK_KIND} ask(s)`,
  });

  const ok = checks.every((c) => c.ok);
  report({ ok, url, checks });
  process.exit(ok ? 0 : 1);
}

function report(result: VerifyResult): void {
  for (const check of result.checks) {
    console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}\n        ${check.detail}`);
  }
  console.log(`\n${result.ok ? "PASS" : "FAIL"}: monitor ask channel`);
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(`verify-monitor-ask-channel crashed: ${err}`);
  process.exit(1);
});
